/**
 * Command families expose one registrar with this shape. The CLI skeleton can
 * add each family to commandRegistrars with a single line, keeping parallel
 * command work isolated to its module and this registry.
 */
export type CommandRegistrar<TProgram = unknown> = (program: TProgram) => void;

export const commandRegistrars: readonly CommandRegistrar[] = [];
