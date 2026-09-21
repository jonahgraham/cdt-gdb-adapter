import { SymbolReader } from '../types/session';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';

type DwarfTag = string;

interface DwarfAttribute {
    name: string;
    rawValue: string;
    stringValue?: string;
    numberValue?: number;
    booleanValue?: boolean;
    referenceOffset?: number;
}

interface DwarfDie {
    offset: number;
    depth: number;
    abbreviationNumber: number;
    tag?: DwarfTag;
    parentOffset?: number;
    compilationUnitOffset: number;
    attributes: Map<string, DwarfAttribute>;
}

interface DwarfFileEntry {
    index: number;
    name: string;
    directoryIndex?: number;
}

interface DwarfCompilationUnit {
    offset: number;
    name?: string;
    compDir?: string;
    stmtListOffset?: number;
    dies: DwarfDie[];
    directories: Map<number, string>;
    files: Map<number, DwarfFileEntry>;
}

interface RawLineTable {
    offset: number;
    directories: Map<number, string>;
    files: Map<number, DwarfFileEntry>;
}

interface ResolvedVariable {
    name: string;
    expression: string;
    sourceFile: string;
    dieOffset: number;
}

interface ParsedDwarfInfo {
    compilationUnits: DwarfCompilationUnit[];
    diesByOffset: Map<number, DwarfDie>;
}

/**
 * Mutable, streaming-friendly state for the "--dwarf=info" parser.
 * Everything that used to be a local variable inside the parseDwarfInfo
 * for-loop now lives here, so a single line can be fed in at a time.
 */
interface DwarfInfoParseState {
    compilationUnits: DwarfCompilationUnit[];
    diesByOffset: Map<number, DwarfDie>;
    currentCu?: DwarfCompilationUnit;
    currentDie?: DwarfDie;
    dieStack: Map<number, DwarfDie>;
}

/**
 * Mutable, streaming-friendly state for the "--dwarf=rawline" parser.
 */
interface RawLineTableParseState {
    tables: RawLineTable[];
    currentTable?: RawLineTable;
    section: 'none' | 'directories' | 'files';
}

export class GNUObjdumpSymbolReader implements SymbolReader {
    protected objdumpPath: string;

    constructor(objdumpPath: string) {
        this.objdumpPath = objdumpPath;
    }

    async readGlobalVariablesByFile(
        elfFile: string
    ): Promise<Map<string, string[]>> {
        // Each stream gets its own parser state. Lines are consumed and
        // discarded as soon as they arrive; only the parsed DWARF structures
        // (dies/attributes/tables) are retained, never the raw text/Buffers.
        const dwarfInfoState = this.createDwarfInfoState();
        const rawLineState = this.createRawLineTableState();

        // Neither parser depends on the other while consuming lines -
        // associateLineTables() below is the only place they interact,
        // and it runs after both streams have fully drained. So the two
        // objdump processes can still run concurrently, same as before.
        await Promise.all([
            this.streamObjdumpLines(
                this.objdumpPath,
                ['--dwarf=info', '--wide', elfFile],
                (line) => this.feedDwarfInfoLine(line, dwarfInfoState)
            ),
            this.streamObjdumpLines(
                this.objdumpPath,
                ['--dwarf=rawline', '--wide', elfFile],
                (line) => this.feedRawLineTableLine(line, rawLineState)
            ),
        ]);

        const dwarfInfo: ParsedDwarfInfo = {
            compilationUnits: dwarfInfoState.compilationUnits,
            diesByOffset: dwarfInfoState.diesByOffset,
        };

        this.associateLineTables(
            dwarfInfo.compilationUnits,
            rawLineState.tables
        );
        const variables = this.collectGlobalVariables(dwarfInfo);
        return this.groupVariablesByFile(variables);
    }

    /**
     * Spawns objdump and invokes `onLine` once per line of stdout, using
     * readline so lines are delivered (and can be discarded) as they arrive
     * instead of being buffered into one large string/Buffer first.
     * stderr is still buffered fully - it is expected to be small and is
     * only used for error reporting on non-zero exit.
     */
    private async streamObjdumpLines(
        objdumpPath: string,
        args: readonly string[],
        onLine: (line: string) => void
    ): Promise<void> {
        const child = spawn(objdumpPath, [...args], {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (chunk: Buffer | string) => {
            stderrChunks.push(
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            );
        });

        // Registered synchronously (before any await) so a fast-exiting
        // process can never fire "close"/"error" before we are listening.
        const closed = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
            child.once('error', (error) => {
                reject(
                    new Error(
                        `Failed to start objdump '${objdumpPath}': ${error.message}`
                    )
                );
            });
            child.once('close', (code, signal) => {
                resolve({ code, signal });
            });
        });

        // Attach a no-op handler immediately so Node never considers this rejection
        // "unhandled" even if it happens well before the `await closed` below is
        // reached (e.g. spawn ENOENT firing while we're still parked in the
        // `for await` loop over stdout). The real error is still thrown normally
        // via `await closed` further down.
        closed.catch(() => {
            /* handled below via `await closed` */
        });

        const rl = readline.createInterface({
            input: child.stdout,
            crlfDelay: Infinity,
        });

        try {
            for await (const line of rl) {
                onLine(line);
            }
        } finally {
            rl.close();
        }

        const { code, signal } = await closed;
        if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            const termination = signal
                ? `signal ${signal}`
                : `exit code ${String(code)}`;
            throw new Error(
                `objdump terminated with ${termination}.` +
                    (stderr ? `\n${stderr}` : '')
            );
        }
    }

    private createDwarfInfoState(): DwarfInfoParseState {
        return {
            compilationUnits: [],
            diesByOffset: new Map(),
            currentCu: undefined,
            currentDie: undefined,
            dieStack: new Map(),
        };
    }

    /**
     * Same logic as the old parseDwarfInfo loop body, called once per line.
     * `continue` statements become `return` since this is now a function
     * invoked per line rather than a loop body.
     */
    private feedDwarfInfoLine(
        rawLine: string,
        state: DwarfInfoParseState
    ): void {
        const trimmedLine = rawLine.trimEnd();

        /*
         * Example:
         * Compilation Unit @ offset 0:
         * Compilation Unit @ offset 0x123:
         */
        const cuMatch = trimmedLine.match(
            /^\s*Compilation Unit @ offset\s+(?:0x)?([0-9a-fA-F]+)\s*:/
        );
        if (cuMatch) {
            const cuOffset = Number.parseInt(cuMatch[1], 16);
            if (!Number.isSafeInteger(cuOffset)) {
                return;
            }
            state.currentCu = {
                offset: cuOffset,
                dies: [],
                directories: new Map(),
                files: new Map(),
            };
            state.compilationUnits.push(state.currentCu);
            state.currentDie = undefined;
            state.dieStack.clear();
            return;
        }

        /*
         * Examples:
         * <0><b>: Abbrev Number: 1 (DW_TAG_compile_unit)
         * <1><1e>: Abbrev Number: 2 (DW_TAG_variable)
         * Spaces are accepted inside both angle-bracket fields.
         */
        const dieMatch = trimmedLine.match(
            /^\s*<\s*(\d+)\s*><\s*(?:0x)?([0-9a-fA-F]+)\s*>\s*:\s*Abbrev Number:\s*(\d+)(?:\s+\((DW_TAG_[^)]+)\))?/
        );
        if (dieMatch) {
            if (!state.currentCu) {
                return;
            }
            const depth = Number.parseInt(dieMatch[1], 10);
            const offset = Number.parseInt(dieMatch[2], 16);
            const abbreviationNumber = Number.parseInt(dieMatch[3], 10);
            const tag = dieMatch[4];
            if (abbreviationNumber === 0) {
                state.currentDie = undefined;
                for (const existingDepth of [...state.dieStack.keys()]) {
                    if (existingDepth >= depth) {
                        state.dieStack.delete(existingDepth);
                    }
                }
                return;
            }
            const parent =
                depth > 0 ? state.dieStack.get(depth - 1) : undefined;
            state.currentDie = {
                offset,
                depth,
                abbreviationNumber,
                tag,
                parentOffset: parent?.offset,
                compilationUnitOffset: state.currentCu.offset,
                attributes: new Map(),
            };
            state.currentCu.dies.push(state.currentDie);
            state.diesByOffset.set(offset, state.currentDie);
            for (const existingDepth of [...state.dieStack.keys()]) {
                if (existingDepth >= depth) {
                    state.dieStack.delete(existingDepth);
                }
            }
            state.dieStack.set(depth, state.currentDie);
            return;
        }

        if (!state.currentDie || !state.currentCu) {
            return;
        }

        /*
         * The important correction is whitespace support:
         * <1f>
         * < 1f>
         * <  1f>
         * <0x1f>
         */
        const attributeMatch = trimmedLine.match(
            /^\s*<\s*(?:0x)?[0-9a-fA-F]+\s*>\s+(DW_AT_[A-Za-z0-9_]+)\s*:\s*(.*)$/
        );
        if (!attributeMatch) {
            return;
        }
        const attributeName = attributeMatch[1];
        const rawValue = attributeMatch[2].trim();
        const attribute = this.parseDwarfAttribute(attributeName, rawValue);
        state.currentDie.attributes.set(attributeName, attribute);
        if (state.currentDie.tag === 'DW_TAG_compile_unit') {
            switch (attributeName) {
                case 'DW_AT_name':
                    state.currentCu.name = attribute.stringValue;
                    break;
                case 'DW_AT_comp_dir':
                    state.currentCu.compDir = attribute.stringValue;
                    break;
                case 'DW_AT_stmt_list':
                    state.currentCu.stmtListOffset = attribute.numberValue;
                    break;
            }
        }
    }

    private parseDwarfAttribute(
        name: string,
        rawValue: string
    ): DwarfAttribute {
        const attribute: DwarfAttribute = { name, rawValue };
        /*
         * References normally appear as:
         * <0x123>
         * <123>
         * There can be suffix text after the reference.
         */
        const referenceMatch = rawValue.match(
            /^(?:\([^)]*\)\s*)?<\s*(?:0x)?([0-9a-fA-F]+)\s*>/
        );
        if (referenceMatch) {
            const referenceOffset = this.parseHex(referenceMatch[1]);
            if (Number.isSafeInteger(referenceOffset)) {
                attribute.referenceOffset = referenceOffset;
            }
        }
        /*
         * GNU objdump frequently adds DWARF form descriptions:
         * (indirect string, offset: 0x123): variableName
         * (indexed string: 0x4): variableName
         * (line string, offset: 0x12): /project/src
         * The source-level value is the text after the final form prefix.
         */
        attribute.stringValue = this.extractStringValue(rawValue);
        const numericValue = this.parseDwarfNumber(rawValue);
        if (numericValue !== undefined) {
            attribute.numberValue = numericValue;
        }
        if (this.isBooleanAttribute(name)) {
            const booleanValue = this.parseDwarfBoolean(rawValue);
            if (booleanValue !== undefined) {
                attribute.booleanValue = booleanValue;
            }
        }
        return attribute;
    }

    private extractStringValue(rawValue: string): string {
        let result = rawValue.trim();
        // Remove one or more parenthesized objdump descriptions at the start
        while (result.startsWith('(')) {
            const closingIndex = result.indexOf('):');
            if (closingIndex < 0) {
                break;
            }
            result = result.slice(closingIndex + 2).trim();
        }
        /*
         * Some versions use: (indirect string, offset: 0x123): value
         * The loop above handles that. This fallback handles other textual
         * prefixes containing a final "):".
         */
        const descriptionEnd = result.lastIndexOf('):');
        if (
            descriptionEnd >= 0 &&
            result.slice(0, descriptionEnd).includes('(')
        ) {
            result = result.slice(descriptionEnd + 2).trim();
        }
        return this.removeSurroundingQuotes(result);
    }

    private parseDwarfNumber(rawValue: string): number | undefined {
        const value = rawValue.trim();
        if (/^(?:\([^)]*\)\s*)?<\s*(?:0x)?[0-9a-fA-F]+\s*>/.test(value)) {
            return undefined;
        }
        const match = value.match(/^(?:\([^)]*\)\s*)?(0x[0-9a-fA-F]+|\d+)\b/);
        if (!match) {
            return undefined;
        }
        return match[1].toLowerCase().startsWith('0x')
            ? Number.parseInt(match[1].slice(2), 16)
            : Number.parseInt(match[1], 10);
    }

    private isBooleanAttribute(name: string): boolean {
        return (
            name === 'DW_AT_declaration' ||
            name === 'DW_AT_external' ||
            name === 'DW_AT_artificial' ||
            name === 'DW_AT_prototyped' ||
            name === 'DW_AT_mutable'
        );
    }

    private parseDwarfBoolean(rawValue: string): boolean | undefined {
        const normalized = rawValue.trim().toLowerCase();
        if (normalized === 'true' || normalized === 'yes') {
            return true;
        }
        if (normalized === 'false' || normalized === 'no') {
            return false;
        }
        if (/\bflag_present\b/.test(normalized)) {
            // DW_FORM_flag_present has no encoded value. Its presence means true
            return true;
        }
        const numericMatch = normalized.match(
            /^(?:\([^)]*\)\s*)?(0x[0-9a-f]+|\d+)\b/
        );
        if (!numericMatch) {
            return undefined;
        }
        const numericValue = numericMatch[1].startsWith('0x')
            ? Number.parseInt(numericMatch[1].slice(2), 16)
            : Number.parseInt(numericMatch[1], 10);
        return numericValue !== 0;
    }

    private createRawLineTableState(): RawLineTableParseState {
        return {
            tables: [],
            currentTable: undefined,
            section: 'none',
        };
    }

    /**
     * Same logic as the old parseRawLineTables loop body, called once per
     * line. `continue` statements become `return`.
     */
    private feedRawLineTableLine(
        rawLine: string,
        state: RawLineTableParseState
    ): void {
        const trimmedLine = rawLine.trimEnd().trim();

        /*
         * Common rawline heading:
         * Offset:   0
         * Offset:   0x1234
         */
        const offsetMatch = trimmedLine.match(
            /^Offset:\s+(?:0x)?([0-9a-fA-F]+)\s*$/
        );
        if (offsetMatch) {
            state.currentTable = {
                offset: this.parseHex(offsetMatch[1]),
                directories: new Map(),
                files: new Map(),
            };
            state.tables.push(state.currentTable);
            state.section = 'none';
            return;
        }

        if (!state.currentTable) {
            return;
        }

        if (
            /The Directory Table/i.test(trimmedLine) ||
            /^Directory Table/i.test(trimmedLine)
        ) {
            state.section = 'directories';
            return;
        }
        if (
            /The File Name Table/i.test(trimmedLine) ||
            /^File Name Table/i.test(trimmedLine)
        ) {
            state.section = 'files';
            return;
        }
        // Once line-number statements begin, the file-table section is over.
        if (
            /Line Number Statements/i.test(trimmedLine) ||
            /Line Number Program/i.test(trimmedLine)
        ) {
            state.section = 'none';
            return;
        }
        if (
            trimmedLine.length === 0 ||
            /^Entry\b/i.test(trimmedLine) ||
            /^Dir\b/i.test(trimmedLine) ||
            /^Name\b/i.test(trimmedLine)
        ) {
            return;
        }

        if (state.section === 'directories') {
            const directory = this.parseRawLineDirectory(trimmedLine);
            if (directory) {
                state.currentTable.directories.set(
                    directory.index,
                    directory.path
                );
            }
            return;
        }

        if (state.section === 'files') {
            const file = this.parseRawLineFile(trimmedLine);
            if (file) {
                state.currentTable.files.set(file.index, file);
            }
        }
    }

    private parseRawLineDirectory(
        line: string
    ): { index: number; path: string } | undefined {
        /*
         * Common formats:
         * 0     /project
         * 1     /project/include
         * DWARF 5 may include string-form annotation:
         * 0     (indirect line string, offset: 0x12): /project
         */
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
            return undefined;
        }
        const index = Number.parseInt(match[1], 10);
        const directoryPath = this.extractStringValue(match[2]);
        if (!directoryPath) {
            return undefined;
        }
        return { index, path: directoryPath };
    }

    private parseRawLineFile(line: string): DwarfFileEntry | undefined {
        /*
         * Common GNU rawline formats:
         * Entry Dir Time Size Name
         * 1     0   0    0    main.c
         *
         * Newer versions may include MD5 columns. Instead of depending on
         * an exact column count, parse:
         * - first number as file index
         * - second number as directory index
         * - final textual field as filename
         */
        const prefixMatch = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
        if (!prefixMatch) {
            return undefined;
        }
        const index = Number.parseInt(prefixMatch[1], 10);
        const directoryIndex = Number.parseInt(prefixMatch[2], 10);
        const remaining = prefixMatch[3];
        const annotatedNameMatch = remaining.match(/\):\s*(.+)$/);
        let name: string | undefined;
        if (annotatedNameMatch) {
            name = this.removeSurroundingQuotes(annotatedNameMatch[1].trim());
        } else {
            /*
             * Traditional output contains time and size before the filename:
             * 0 0 main.c
             * Remove two numeric columns when they exist.
             */
            const traditionalMatch = remaining.match(
                /^(?:0x[0-9a-fA-F]+|\d+)\s+(?:0x[0-9a-fA-F]+|\d+)\s+(.+)$/
            );
            if (traditionalMatch) {
                name = traditionalMatch[1].trim();
            } else {
                /*
                 * Fallback for versions that format the additional columns
                 * differently. The final whitespace-delimited item is used.
                 * Paths with spaces should normally appear through an annotated
                 * string form and therefore use the branch above.
                 */
                const fields = remaining.trim().split(/\s+/);
                name = fields.at(-1);
            }
        }
        if (!name) {
            return undefined;
        }
        return {
            index,
            directoryIndex,
            name: this.removeSurroundingQuotes(name),
        };
    }

    private associateLineTables(
        compilationUnits: DwarfCompilationUnit[],
        lineTables: RawLineTable[]
    ): void {
        const lineTablesByOffset = new Map<number, RawLineTable>();
        for (const table of lineTables) {
            lineTablesByOffset.set(table.offset, table);
        }
        for (const cu of compilationUnits) {
            if (cu.stmtListOffset === undefined) {
                continue;
            }
            const table = lineTablesByOffset.get(cu.stmtListOffset);
            if (!table) {
                continue;
            }
            cu.directories = new Map(table.directories);
            cu.files = new Map(table.files);
        }
    }

    private collectGlobalVariables(
        dwarfInfo: ParsedDwarfInfo
    ): ResolvedVariable[] {
        const cus = new Map<number, DwarfCompilationUnit>();
        for (const cu of dwarfInfo.compilationUnits) {
            cus.set(cu.offset, cu);
        }
        interface Candidate extends ResolvedVariable {
            rank: number;
        }
        const candidates = new Map<string, Candidate>();
        for (const cu of dwarfInfo.compilationUnits) {
            for (const die of cu.dies) {
                if (die.tag !== 'DW_TAG_variable') continue;
                if (!this.isSourceGlobalVariable(die, dwarfInfo.diesByOffset)) {
                    continue;
                }
                const hasStorage =
                    die.attributes.has('DW_AT_location') ||
                    die.attributes.has('DW_AT_const_value');
                const isDeclaration =
                    this.getDirectBooleanAttribute(die, 'DW_AT_declaration') ===
                    true;
                if (isDeclaration && !hasStorage) {
                    continue;
                }
                const rawName = this.resolveStringAttribute(
                    die,
                    'DW_AT_name',
                    dwarfInfo.diesByOffset
                );
                const name =
                    rawName === undefined
                        ? undefined
                        : this.normalizeVariableName(rawName);
                if (
                    !name ||
                    this.isArtificialName(name) ||
                    this.isCompilerGeneratedSymbol(name)
                ) {
                    continue;
                }
                const specification = this.getReferencedDie(
                    die,
                    'DW_AT_specification',
                    dwarfInfo.diesByOffset
                );
                const expression = this.buildQualifiedVariableName(
                    specification ?? die,
                    name,
                    dwarfInfo.diesByOffset
                );
                let sourceFile: string | undefined;
                let sourceRank = 0;
                const directIndex =
                    die.attributes.get('DW_AT_decl_file')?.numberValue;
                if (directIndex !== undefined) {
                    sourceFile = this.resolveSourceFile(
                        cus.get(die.compilationUnitOffset) ?? cu,
                        directIndex
                    );
                    if (sourceFile) sourceRank = 3;
                }
                if (!sourceFile) {
                    const owner = this.resolveAttributeOwner(
                        die,
                        'DW_AT_decl_file',
                        dwarfInfo.diesByOffset
                    );
                    const index = this.resolveNumberAttribute(
                        die,
                        'DW_AT_decl_file',
                        dwarfInfo.diesByOffset
                    );
                    const ownerCu = owner
                        ? cus.get(owner.compilationUnitOffset)
                        : undefined;
                    if (ownerCu && index !== undefined) {
                        sourceFile = this.resolveSourceFile(ownerCu, index);
                        if (sourceFile) sourceRank = 2;
                    }
                }
                if (!sourceFile) {
                    sourceFile = this.resolveCompilationUnitName(
                        cus.get(die.compilationUnitOffset) ?? cu
                    );
                    if (sourceFile) sourceRank = 1;
                }
                if (!sourceFile) {
                    continue;
                }
                const normalizedFile = this.normalizePortablePath(sourceFile);
                const key = `${normalizedFile}\0${expression}`;
                const rank = (hasStorage ? 10 : 0) + sourceRank;
                const previous = candidates.get(key);
                if (
                    !previous ||
                    rank > previous.rank ||
                    (rank === previous.rank && die.offset < previous.dieOffset)
                ) {
                    candidates.set(key, {
                        name,
                        expression,
                        sourceFile: normalizedFile,
                        dieOffset: die.offset,
                        rank,
                    });
                }
            }
        }
        const result: ResolvedVariable[] = [...candidates.values()].map(
            ({ rank: _rank, ...variable }) => variable
        );
        return result;
    }

    private resolveAttributeOwner(
        die: DwarfDie,
        attributeName: string,
        diesByOffset: Map<number, DwarfDie>,
        visited = new Set<number>()
    ): DwarfDie | undefined {
        if (visited.has(die.offset)) {
            return undefined;
        }
        visited.add(die.offset);
        if (die.attributes.has(attributeName)) {
            return die;
        }
        for (const referenceAttributeName of [
            'DW_AT_specification',
            'DW_AT_abstract_origin',
        ]) {
            const referenceAttribute = die.attributes.get(
                referenceAttributeName
            );
            const referencedOffset = referenceAttribute?.referenceOffset;
            if (referencedOffset === undefined) {
                continue;
            }
            const referencedDie = diesByOffset.get(referencedOffset);
            if (!referencedDie) {
                continue;
            }
            const owner = this.resolveAttributeOwner(
                referencedDie,
                attributeName,
                diesByOffset,
                visited
            );
            if (owner) {
                return owner;
            }
        }
        return undefined;
    }

    private getDirectBooleanAttribute(
        die: DwarfDie,
        attributeName: string
    ): boolean | undefined {
        const attribute = die.attributes.get(attributeName);
        if (!attribute) {
            return undefined;
        }
        if (attribute.booleanValue !== undefined) {
            return attribute.booleanValue;
        }
        if (attribute.numberValue !== undefined) {
            return attribute.numberValue !== 0;
        }
        return undefined;
    }

    private getReferencedDie(
        die: DwarfDie,
        attributeName: string,
        diesByOffset: Map<number, DwarfDie>
    ): DwarfDie | undefined {
        const offset = die.attributes.get(attributeName)?.referenceOffset;
        return offset !== undefined ? diesByOffset.get(offset) : undefined;
    }

    private hasLocalScopeAncestor(
        die: DwarfDie,
        diesByOffset: Map<number, DwarfDie>
    ): boolean {
        let parentOffset = die.parentOffset;
        const visited = new Set<number>();
        while (parentOffset !== undefined) {
            if (visited.has(parentOffset)) {
                return true;
            }
            visited.add(parentOffset);
            const parent = diesByOffset.get(parentOffset);
            if (!parent) {
                return true;
            }
            switch (parent.tag) {
                case 'DW_TAG_subprogram':
                case 'DW_TAG_lexical_block':
                case 'DW_TAG_inlined_subroutine':
                case 'DW_TAG_try_block':
                case 'DW_TAG_catch_block':
                case 'DW_TAG_with_stmt':
                    return true;
                case 'DW_TAG_compile_unit':
                case 'DW_TAG_partial_unit':
                    return false;
            }
            parentOffset = parent.parentOffset;
        }
        return true;
    }

    private reachesCompilationUnit(
        die: DwarfDie,
        diesByOffset: Map<number, DwarfDie>
    ): boolean {
        let current: DwarfDie | undefined = die;
        const visited = new Set<number>();
        while (current) {
            if (visited.has(current.offset)) {
                return false;
            }
            visited.add(current.offset);
            if (
                current.tag === 'DW_TAG_compile_unit' ||
                current.tag === 'DW_TAG_partial_unit'
            ) {
                return true;
            }
            current =
                current.parentOffset !== undefined
                    ? diesByOffset.get(current.parentOffset)
                    : undefined;
        }
        return false;
    }

    private isSourceGlobalVariable(
        die: DwarfDie,
        diesByOffset: Map<number, DwarfDie>
    ): boolean {
        if (this.hasLocalScopeAncestor(die, diesByOffset)) {
            return false;
        }
        /*
         * If this DIE references a declaration/specification, make sure that
         * semantic declaration is not inside a function either.
         */
        const specification =
            this.getReferencedDie(die, 'DW_AT_specification', diesByOffset) ??
            this.getReferencedDie(die, 'DW_AT_abstract_origin', diesByOffset);
        if (
            specification &&
            this.hasLocalScopeAncestor(specification, diesByOffset)
        ) {
            return false;
        }
        return this.reachesCompilationUnit(die, diesByOffset);
    }

    private resolveStringAttribute(
        die: DwarfDie,
        attributeName: string,
        diesByOffset: Map<number, DwarfDie>
    ): string | undefined {
        return this.resolveAttribute(die, attributeName, diesByOffset)
            ?.stringValue;
    }

    private resolveNumberAttribute(
        die: DwarfDie,
        attributeName: string,
        diesByOffset: Map<number, DwarfDie>
    ): number | undefined {
        return this.resolveAttribute(die, attributeName, diesByOffset)
            ?.numberValue;
    }

    /**
     * Resolves an attribute directly or through:
     * - DW_AT_specification
     * - DW_AT_abstract_origin
     * The direct DIE always takes precedence.
     */
    private resolveAttribute(
        die: DwarfDie,
        attributeName: string,
        diesByOffset: Map<number, DwarfDie>,
        visited = new Set<number>()
    ): DwarfAttribute | undefined {
        if (visited.has(die.offset)) {
            return undefined;
        }
        visited.add(die.offset);
        const direct = die.attributes.get(attributeName);
        if (direct !== undefined) {
            return direct;
        }
        for (const referenceAttributeName of [
            'DW_AT_specification',
            'DW_AT_abstract_origin',
        ]) {
            const referenceAttribute = die.attributes.get(
                referenceAttributeName
            );
            const referencedOffset = referenceAttribute?.referenceOffset;
            if (referencedOffset === undefined) {
                continue;
            }
            const referencedDie = diesByOffset.get(referencedOffset);
            if (!referencedDie) {
                continue;
            }
            const inherited = this.resolveAttribute(
                referencedDie,
                attributeName,
                diesByOffset,
                visited
            );
            if (inherited !== undefined) {
                return inherited;
            }
        }
        return undefined;
    }

    private buildQualifiedVariableName(
        die: DwarfDie,
        simpleName: string,
        diesByOffset: Map<number, DwarfDie>
    ): string {
        /*
         * A source name already containing qualification should not be
         * qualified a second time.
         */
        if (simpleName.includes('::')) {
            return simpleName;
        }
        const components = [simpleName];
        const visited = new Set<number>();
        let parentOffset = die.parentOffset;
        while (parentOffset !== undefined) {
            if (visited.has(parentOffset)) {
                break;
            }
            visited.add(parentOffset);
            const parent = diesByOffset.get(parentOffset);
            if (!parent) {
                break;
            }
            switch (parent.tag) {
                case 'DW_TAG_namespace':
                case 'DW_TAG_class_type':
                case 'DW_TAG_structure_type':
                case 'DW_TAG_union_type': {
                    const parentName = this.resolveStringAttribute(
                        parent,
                        'DW_AT_name',
                        diesByOffset
                    );
                    /*
                     * Ignore unnamed/anonymous scopes. Their source-level
                     * expression cannot be reconstructed safely from objdump
                     * text alone.
                     */
                    if (parentName && !this.isAnonymousScopeName(parentName)) {
                        components.unshift(parentName);
                    }
                    break;
                }
                case 'DW_TAG_compile_unit':
                case 'DW_TAG_partial_unit':
                    return components.join('::');
            }
            parentOffset = parent.parentOffset;
        }
        return components.join('::');
    }

    private isAnonymousScopeName(name: string): boolean {
        const normalized = name.trim().toLowerCase();
        return (
            normalized.length === 0 ||
            normalized.includes('anonymous namespace') ||
            normalized.includes('<anonymous>') ||
            normalized.includes('(anonymous)')
        );
    }

    private normalizeVariableName(name: string): string {
        let normalized = name.trim();
        const form = normalized.match(
            /^\((?:indirect\s+|indexed\s+|line\s+)?string(?:[^)]*)?\)\s*:?\s*(.+)$/i
        );
        if (form) {
            normalized = form[1].trim();
        }
        return this.removeSurroundingQuotes(normalized).trim();
    }

    private isCompilerGeneratedSymbol(name: string): boolean {
        return (
            name.includes('$$') ||
            /^__(?:preinit|init|fini)_array_(?:start|end)$/.test(name) ||
            name === '__Vectors' ||
            name === '__Vectors_End' ||
            name === '__Vectors_Size'
        );
    }

    private isArtificialName(name: string): boolean {
        const trimmed = name.trim();
        return (
            trimmed.length === 0 ||
            trimmed === '<anonymous>' ||
            trimmed === '<artificial>'
        );
    }

    private resolveSourceFile(
        cu: DwarfCompilationUnit,
        declFileIndex: number
    ): string | undefined {
        const fileEntry = cu.files.get(declFileIndex);
        if (!fileEntry) {
            /*
             * Some objdump/DWARF combinations expose the CU source file without
             * a usable line-table entry. Use the CU name only when the requested
             * index is conventionally the main source entry.
             */
            if ((declFileIndex === 0 || declFileIndex === 1) && cu.name) {
                return this.resolveCompilationUnitName(cu);
            }
            return undefined;
        }
        const fileName = this.normalizeDwarfPath(fileEntry.name);
        if (this.isAbsolutePortable(fileName)) {
            return this.normalizePortablePath(fileName);
        }
        let directory: string | undefined;
        if (fileEntry.directoryIndex !== undefined) {
            directory = cu.directories.get(fileEntry.directoryIndex);
        }
        if (directory) {
            directory = this.normalizeDwarfPath(directory);
            if (!this.isAbsolutePortable(directory) && cu.compDir) {
                directory = this.joinPortable(
                    this.normalizeDwarfPath(cu.compDir),
                    directory
                );
            }
            return this.normalizePortablePath(
                this.joinPortable(directory, fileName)
            );
        }
        if (cu.compDir) {
            return this.normalizePortablePath(
                this.joinPortable(this.normalizeDwarfPath(cu.compDir), fileName)
            );
        }
        /*
         * CU name may contain a path even when comp_dir is absent.
         */
        if (cu.name) {
            const cuName = this.normalizeDwarfPath(cu.name);
            const cuDirectory = this.dirnamePortable(cuName);
            if (cuDirectory && cuDirectory !== '.') {
                return this.normalizePortablePath(
                    this.joinPortable(cuDirectory, fileName)
                );
            }
        }
        return this.normalizePortablePath(fileName);
    }

    private resolveCompilationUnitName(
        cu: DwarfCompilationUnit
    ): string | undefined {
        if (!cu.name) {
            return undefined;
        }
        const cuName = this.normalizeDwarfPath(cu.name);
        if (this.isAbsolutePortable(cuName)) {
            return this.normalizePortablePath(cuName);
        }
        if (cu.compDir) {
            return this.normalizePortablePath(
                this.joinPortable(this.normalizeDwarfPath(cu.compDir), cuName)
            );
        }
        return this.normalizePortablePath(cuName);
    }

    private groupVariablesByFile(
        variables: ResolvedVariable[]
    ): Map<string, string[]> {
        const namesByFullPath = new Map<string, Set<string>>();
        for (const variable of variables) {
            const fullPath = this.normalizePortablePath(variable.sourceFile);
            const names = namesByFullPath.get(fullPath) ?? new Set<string>();
            names.add(variable.expression);
            namesByFullPath.set(fullPath, names);
        }
        return new Map(
            [...namesByFullPath].map(([key, value]) => [key, [...value]])
        );
    }

    /**
     * DWARF generated on Windows may contain backslashes even when the adapter
     * runs on Linux, and vice versa. Use "/" internally to avoid interpreting
     * target paths using only the host platform's path rules.
     */
    private normalizeDwarfPath(value: string): string {
        return this.removeSurroundingQuotes(value.trim()).replace(/\\/g, '/');
    }

    private normalizePortablePath(value: string): string {
        const normalized = this.normalizeDwarfPath(value);
        /*
         * path.posix.normalize preserves a Windows drive prefix such as C:
         * while normalizing the remainder of the path.
         */
        return path.posix.normalize(normalized);
    }

    private isAbsolutePortable(value: string): boolean {
        return (
            value.startsWith('/') ||
            /^[A-Za-z]:[\\/]/.test(value) ||
            /^\\\\/.test(value)
        );
    }

    private joinPortable(left: string, right: string): string {
        if (this.isAbsolutePortable(right)) {
            return this.normalizePortablePath(right);
        }
        return this.normalizePortablePath(
            `${left.replace(/[\\/]+$/, '')}/${right.replace(/^[\\/]+/, '')}`
        );
    }

    private dirnamePortable(value: string): string {
        return path.posix.dirname(this.normalizeDwarfPath(value));
    }

    private parseHex(value: string): number {
        return Number.parseInt(value, 16);
    }

    private removeSurroundingQuotes(value: string): string {
        if (value.length < 2) {
            return value;
        }
        const first = value[0];
        const last = value[value.length - 1];
        if (
            (first === '"' && last === '"') ||
            (first === "'" && last === "'")
        ) {
            return value.slice(1, -1);
        }
        return value;
    }
}
