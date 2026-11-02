export interface AuthenticatedProject {
  id: string;
  accountId: string;
  name: string;
  status: string;
  apiKeyId: string;
}

export interface AuthenticatedUploadToken {
  assetId: string;
  projectId: string;
  fileSizeBytes: number;
  storageKey: string;
}
