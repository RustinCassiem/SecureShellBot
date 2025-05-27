"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScriptExecutor = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execPromise = (0, util_1.promisify)(child_process_1.exec);
class ScriptExecutor {
    executeScript(scriptPath) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Don't add bash prefix
                const { stdout, stderr } = yield execPromise(scriptPath);
                if (stderr) {
                    console.log("Command stderr:", stderr);
                }
                return stdout;
            }
            catch (error) {
                if (error instanceof Error) {
                    throw new Error(`Error executing script: ${error.message}`);
                }
                throw new Error('Unknown error executing script');
            }
        });
    }
}
exports.ScriptExecutor = ScriptExecutor;
