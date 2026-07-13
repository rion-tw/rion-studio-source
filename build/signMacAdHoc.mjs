import { signAsync } from "@electron/osx-sign";

export default async function signMacAdHoc(configuration) {
  await signAsync({
    ...configuration,
    identity: "-",
    identityValidation: false,
    timestamp: "none"
  });
}
