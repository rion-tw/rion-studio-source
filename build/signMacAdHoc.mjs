import { sign } from "@electron/osx-sign";

export default async function signMacAdHoc(configuration) {
  await sign({
    ...configuration,
    identity: "-",
    identityValidation: false,
    timestamp: "none"
  });
}
