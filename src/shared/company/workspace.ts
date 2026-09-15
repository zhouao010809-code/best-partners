export const companyRuntimeModes = ['personal', 'company'] as const;

export type CompanyRuntimeMode = typeof companyRuntimeModes[number];

export interface CompanyWorkspaceManifest {
  readonly id: string;
  readonly displayName: string;
  readonly rootPath: string;
  readonly incomingPath: string;
  readonly projectsPath: string;
  readonly skillsPath: string;
  readonly systemPath: string;
}
