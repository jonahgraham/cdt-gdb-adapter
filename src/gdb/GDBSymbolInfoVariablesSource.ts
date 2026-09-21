import { IGDBBackend } from '../types/gdb';
import { SymbolSource } from '../types/session';
import * as mi from '../mi';

export class GDBSymbolInfoVariablesSource implements SymbolSource {
    private readonly cache = new Map<number, Map<string, string[]>>();

    constructor(private readonly gdb: IGDBBackend) {}

    async notifySymbolFileLoaded(inferiorId: number): Promise<void> {
        this.cache.delete(inferiorId);
    }

    async getGlobalVariablesByFile(
        inferiorId: number
    ): Promise<Map<string, string[]>> {
        let cached = this.cache.get(inferiorId);
        if (!cached) {
            const result = await mi.sendSymbolInfoVars(this.gdb);
            cached = new Map(
                result.symbols.debug.map((debug) => [
                    debug.filename,
                    debug.symbols.map((variable) => variable.name),
                ])
            );
            this.cache.set(inferiorId, cached);
        }
        return cached;
    }
}
