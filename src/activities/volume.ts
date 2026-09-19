import { getEnv } from "../lib/env";
import { podman } from "../lib/podman";

export async function ensurePotatoVolume(): Promise<string> {
  const { potatoDataVolume } = getEnv();
  const exists = await podman.volumeExists(potatoDataVolume);
  if (!exists) {
    await podman.volumeCreate(potatoDataVolume);
  }
  return potatoDataVolume;
}
