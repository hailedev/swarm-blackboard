// Core never generates randomness. Ids (UUID v7 strings) arrive through this interface.
export interface IdGenerator {
  next(): string;
}
