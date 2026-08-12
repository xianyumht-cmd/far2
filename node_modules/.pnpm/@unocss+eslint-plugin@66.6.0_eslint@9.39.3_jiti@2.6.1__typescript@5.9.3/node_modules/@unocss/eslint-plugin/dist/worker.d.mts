import { BlocklistMeta, UnoGenerator } from "@unocss/core";

//#region src/worker.d.ts
declare function getGenerator(configPath?: string, id?: string): Promise<UnoGenerator<any>>;
declare function setGenerator(generator: Awaited<UnoGenerator<any>>, configPath?: string | undefined): void;
declare function runAsync(configPath: string | undefined, action: 'sort', classes: string, id?: string): Promise<string>;
declare function runAsync(configPath: string | undefined, action: 'blocklist', classes: string, id?: string): Promise<[string, BlocklistMeta | undefined][]>;
declare function run(configPath: string | undefined, action: 'sort', classes: string, id?: string): string;
declare function run(configPath: string | undefined, action: 'blocklist', classes: string, id?: string): [string, BlocklistMeta | undefined][];
//#endregion
export { getGenerator, run, runAsync, setGenerator };