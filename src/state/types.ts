export interface StateStore {
  load(): Promise<void>;
  save(): Promise<void>;
  has(id: string): Promise<boolean>;
  add(id: string): Promise<void>;
  claim(id: string): Promise<boolean>;
  unclaim(id: string): Promise<void>;
  close(): Promise<void>;
  readonly persistsOnWrite: boolean;
  readonly backendName: string;
}
