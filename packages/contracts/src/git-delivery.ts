export interface GitDeliveryChange {
  path: string;
  action: 'add' | 'modify';
  size: number;
  artifactId: string;
  versionId: string;
}

export interface GitDeliveryPreview {
  operationId: string;
  commissionId: string;
  revision: number;
  acceptedVersionIds: string[];
  remote: string;
  baseBranch: string;
  baseCommit: string;
  targetBranch: string;
  changes: GitDeliveryChange[];
  diff: string;
  diffTruncated: boolean;
}

export interface GitDeliveryReceipt {
  preview: GitDeliveryPreview;
  status: 'prepared' | 'published' | 'blocked' | 'unknown';
  commit: string | null;
  compareUrl: string | null;
  message: string | null;
  updatedAt: string;
}
