import { log, heartbeat } from "@temporalio/activity";
import { getEnv } from "../lib/env";
import { podman } from "../lib/podman";

export type PullUsedImagesResult = {
  images: string[];
};

/**
 * Pull configured Potato + sitespeed images so `:latest` (and other floating
 * tags) are refreshed before maintenance / test runs that use them.
 */
export async function pullUsedImages(): Promise<PullUsedImagesResult> {
  const env = getEnv();
  const images = [env.potatoImage, env.sitespeedImage];
  const pulled: string[] = [];

  for (const image of images) {
    heartbeat({ step: "pull-image", image });
    log.info("Pulling container image", { image });
    await podman.pullImage(image);
    pulled.push(image);
  }

  return { images: pulled };
}
