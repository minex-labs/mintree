import { exec } from "child_process";
import { promisify } from "util";
const execAsync = promisify(exec);
export async function tryExec(command) {
    try {
        const { stdout } = await execAsync(command);
        return stdout.trim();
    }
    catch {
        return null;
    }
}
export async function getPath(command) {
    return tryExec(`which ${command}`);
}
