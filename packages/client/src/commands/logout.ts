import { clearConfig, loadConfig } from "../config";
import { writeOutput, type OutputOptions } from "../output";

export async function logout(
  outputOptions: OutputOptions = {},
  configPath?: string,
): Promise<void> {
  if (!loadConfig(configPath)) {
    writeOutput(
      { logged_out: false, status: "ok" },
      outputOptions,
      "Not logged in.",
    );
    return;
  }

  clearConfig(configPath);
  writeOutput({ logged_out: true, status: "ok" }, outputOptions, "Logged out.");
}
