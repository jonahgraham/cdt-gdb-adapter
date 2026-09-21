import { SymbolSource, SymbolReader } from '../types/session';

export class AggregatingSymbolFileSource implements SymbolSource {
    private readonly parsedByFile = new Map<
        string,
        Promise<Map<string, string[]>>
    >();
    private readonly loadedFilesByInferior = new Map<number, Set<string>>();

    constructor(private readonly symbolReader: SymbolReader) {}

    async notifySymbolFileLoaded(
        inferiorId: number,
        filePath: string
    ): Promise<void> {
        const loadedFiles =
            this.loadedFilesByInferior.get(inferiorId) ?? new Set<string>();
        this.loadedFilesByInferior.set(inferiorId, loadedFiles);
        const alreadyLoadedByThisInferior = loadedFiles.has(filePath);

        const needsParse =
            !this.parsedByFile.has(filePath) || alreadyLoadedByThisInferior;
        if (needsParse) {
            const parsePromise =
                this.symbolReader.readGlobalVariablesByFile(filePath);
            parsePromise.catch(() => undefined);
            this.parsedByFile.set(filePath, parsePromise);
        }

        loadedFiles.add(filePath);
        this.loadedFilesByInferior.set(inferiorId, loadedFiles);
        await this.parsedByFile.get(filePath);
    }

    private toDisplayPath(
        symbolFilePath: string,
        absolutePath: string
    ): string {
        const normalize = (value: string) => value.replace(/\\/g, '/');
        const symbolNorm = normalize(symbolFilePath);
        const targetNorm = normalize(absolutePath);

        const isWindowsStyle =
            /^[A-Za-z]:\//.test(symbolNorm) || /^[A-Za-z]:\//.test(targetNorm);

        // Base = the ELF's containing directory,
        const symbolParts = symbolNorm.split('/').filter(Boolean);
        const rootParts = symbolParts.slice(0, -1);
        const targetParts = targetNorm.split('/').filter(Boolean);

        const segmentsEqual = (a: string, b: string) =>
            isWindowsStyle ? a.toLowerCase() === b.toLowerCase() : a === b;

        let sharedLength = 0;
        while (
            sharedLength < rootParts.length &&
            sharedLength < targetParts.length &&
            segmentsEqual(rootParts[sharedLength], targetParts[sharedLength])
        ) {
            sharedLength++;
        }

        // No shared ancestor at all: fall back to the absolute path rather
        // than emitting a confusing, deeply-nested "../../.." chain.
        if (sharedLength === 0) {
            return targetNorm;
        }

        const upSegments = new Array(rootParts.length - sharedLength).fill(
            '..'
        );
        const downSegments = targetParts.slice(sharedLength);
        const relativePath = [...upSegments, ...downSegments].join('/');
        return upSegments.length === 0 ? `./${relativePath}` : relativePath;
    }

    async getGlobalVariablesByFile(
        inferiorId: number
    ): Promise<Map<string, string[]>> {
        const merged = new Map<string, string[]>();
        for (const filePath of this.loadedFilesByInferior.get(inferiorId) ??
            []) {
            const parsePromise = this.parsedByFile.get(filePath);
            if (!parsePromise) {
                continue;
            }
            let parsed: Map<string, string[]>;
            try {
                parsed = await parsePromise;
            } catch {
                // A file that failed to parse contributes nothing, it
                // must not prevent other successfully-loaded files for
                // this same inferior from being shown.
                continue;
            }
            for (const [sourceFile, names] of parsed) {
                const displayFile = this.toDisplayPath(filePath, sourceFile);
                const existing = merged.get(displayFile) ?? [];
                merged.set(displayFile, [...new Set([...existing, ...names])]);
            }
        }
        return merged;
    }
}
