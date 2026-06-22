export interface MetaPreview {
  id: string;
  type: string;
  name: string;
  poster?: string;
  year?: number;
}

export interface Manifest {
  id: string;
  version: string;
  name: string;
  description: string;
  resources: string[];
  types: string[];
  catalogs: any[];
  idPrefixes: string[];
  behaviorHints: { configurable: boolean; configurationRequired: boolean };
}
