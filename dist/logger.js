"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const winston_1 = __importDefault(require("winston"));
const path_1 = __importDefault(require("path"));
// Create logger instance
const logger = winston_1.default.createLogger({
    level: 'info',
    format: winston_1.default.format.combine(winston_1.default.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }), winston_1.default.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)),
    transports: [
        // Log to the console
        new winston_1.default.transports.Console({
            format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`))
        }),
        // Log to a file
        new winston_1.default.transports.File({
            filename: path_1.default.join(__dirname, '../logs/bot.log'),
            maxsize: 5242880,
            maxFiles: 5
        })
    ]
});
// Create logs directory if it doesn't exist
const fs_1 = __importDefault(require("fs"));
const logDir = path_1.default.join(__dirname, '../logs');
if (!fs_1.default.existsSync(logDir)) {
    fs_1.default.mkdirSync(logDir, { recursive: true });
}
exports.default = logger;
