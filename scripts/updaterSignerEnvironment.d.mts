export function createUpdaterSignerEnvironment(
  environment: NodeJS.ProcessEnv,
  signerHome: string
): NodeJS.ProcessEnv;

export function createUpdaterSignerGenerationEnvironment(
  environment: NodeJS.ProcessEnv,
  signerHome: string
): NodeJS.ProcessEnv;

export function resolveUpdaterSignerEntrypoint(
  workingDirectory?: string
): Promise<string>;

export function signUpdaterArtifact(input: Readonly<{
  artifactPath: string;
  environment: NodeJS.ProcessEnv;
  workingDirectory?: string;
}>): Promise<void>;
