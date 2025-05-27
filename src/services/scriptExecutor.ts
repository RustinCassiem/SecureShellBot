import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

export class ScriptExecutor {
    async executeScript(scriptPath: string): Promise<string> {
        try {
            // Don't add bash prefix
            const { stdout, stderr } = await execPromise(scriptPath);
            if (stderr) {
                console.log("Command stderr:", stderr);
            }
            return stdout;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`Error executing script: ${error.message}`);
            }
            throw new Error('Unknown error executing script');
        }
    }
}