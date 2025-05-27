export interface BotCommand {
    command: string;
    description: string;
}

export interface ScriptExecutionResult {
    success: boolean;
    output: string;
    error?: string;
}