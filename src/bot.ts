// Disable SSL verification for development only
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import 'dotenv/config';
import { Context, Telegraf, Markup } from 'telegraf';
import { ScriptExecutor } from './services/scriptExecutor';
import logger from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import ldap from 'ldapjs';
import { NodeSSH } from 'node-ssh';
import fs from 'fs';
import path from 'path';

// Initialize bot with token from .env
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not set in environment variables');
}
const bot = new Telegraf(BOT_TOKEN);
const scriptExecutor = new ScriptExecutor();
const ssh = new NodeSSH();

// User state management
type UserState = {
    step: 'awaiting_username' | 'awaiting_password' | 'selecting_server' | 'awaiting_sudo_user' | 
          'selecting_script' | 'asking_run_more_commands' | 'asking_logout_or_continue' | 
          'asking_same_or_different_server';
    username?: string;
    password?: string;
    selectedServer?: string;
    selectedServerName?: string; // Add this to store the server name
    sudoUser?: string;
    currentCommandPage?: number;
};

const userStates = new Map<number, UserState>();
const authenticatedUsers = new Set<number>();
const userMessages = new Map<number, number[]>();

// LDAP configuration
const LDAP_URL = process.env.LDAP_URL;
const LDAP_BASE_DN = process.env.LDAP_BASE_DN;
const LDAP_USER_DN = process.env.LDAP_USER_DN || 'uid';

// Servers and available scripts
type Server = { name: string; ip: string };
type Script = { name: string; command: string };

// Whitelisted users (comma-separated user IDs in .env, e.g. WHITELISTED_USERS=12345,67890)
const WHITELISTED_USERS = process.env.WHITELISTED_USERS 
  ? process.env.WHITELISTED_USERS.split(',').map(id => Number(id.trim()))
  : [];

// Log the whitelisted users for verification (without exposing them in user-facing logs)
logger.info(`Whitelisted users configured: ${WHITELISTED_USERS.length}`);

const SERVERS: Server[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../servers.json'), 'utf-8'));
const SCRIPTS: Script[] = JSON.parse(fs.readFileSync(path.join(__dirname, '../commands.json'), 'utf-8'));

// Enhance the deleteMessages function for better cleanup
async function deleteMessages(ctx: Context, userId: number): Promise<void> {
    if (!userMessages.has(userId)) return;
  
    const messagesToDelete = userMessages.get(userId) || [];
    logger.info(`Attempting to delete ${messagesToDelete.length} messages for user ${userId}`);
    
    let deletedCount = 0;
    let failedCount = 0;
    
    for (const msgId of messagesToDelete) {
        try {
            await ctx.deleteMessage(msgId);
            deletedCount++;
        } catch (e) {
            // Some messages may be too old to delete (Telegram limitation)
            failedCount++;
        }
    }
    
    logger.info(`Deleted ${deletedCount}/${messagesToDelete.length} messages for user ${userId} (${failedCount} failed)`);
    userMessages.set(userId, []); // Clear tracked messages
}

// Fix the trackMessage function
async function trackMessage(ctx: Context, userId: number, text: string, extra?: any): Promise<any> {
    // Replace console.log with logger.info
    if (extra && extra.reply_markup) {
        logger.info(`Sending keyboard: ${JSON.stringify(extra.reply_markup)}`);
    }
    
    const msg = await ctx.reply(text, extra);
    if (!userMessages.has(userId)) {
        userMessages.set(userId, []);
    }
    if (msg && 'message_id' in msg) {
        userMessages.get(userId)?.push(msg.message_id);
    }
    return msg;
}

// Start command
bot.start(async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    
    logger.info(`User ${ctx.from.username || userId} attempted to start the bot`);
    
    // Check if user is whitelisted
    if (WHITELISTED_USERS.length > 0 && !WHITELISTED_USERS.includes(userId)) {
        await ctx.reply('You are not whitelisted to use this application. Please speak to the administrator of this bot to request access.');
        logger.info(`Access denied for user ${ctx.from.username || userId} (ID: ${userId}) - not in whitelist`);
        return;
    }
    
    logger.info(`User ${ctx.from.username || userId} started the bot`);
    
    userStates.delete(userId);
    authenticatedUsers.delete(userId);
    
    await deleteMessages(ctx, userId);
    
    // Start authentication flow
    await trackMessage(ctx, userId, 'Welcome! Please enter your username:');
    userStates.set(userId, { step: 'awaiting_username' });
});

// LDAP authentication
async function authenticateLDAP(username: string, password: string): Promise<boolean> {
    return new Promise((resolve) => {
        if (!LDAP_URL || !LDAP_BASE_DN || !process.env.LDAP_BIND_DN || !process.env.LDAP_BIND_PASSWORD) {
            logger.error("Missing LDAP configuration");
            return resolve(false);
        }
        
        logger.info(`Attempting LDAP authentication for user: ${username}`);
        const client = ldap.createClient({ url: LDAP_URL });

        // First bind with the service account
        client.bind(process.env.LDAP_BIND_DN, process.env.LDAP_BIND_PASSWORD, (err) => {
            if (err) {
                logger.error(`LDAP bind error: ${err.message}`);
                client.unbind();
                return resolve(false);
            }
            
            logger.info("LDAP bind successful");
            // Search for the user's DN
            const opts = {
                filter: `(${LDAP_USER_DN}=${username})`,
                scope: 'sub' as 'sub',
                attributes: ['dn']
            };

            client.search(LDAP_BASE_DN, opts, (err, res) => {
                if (err) {
                    client.unbind();
                    return resolve(false);
                }

                let userDN = '';
                res.on('searchEntry', (entry) => {
                    // No logging of sensitive DN information
                    userDN = entry.dn.toString();
                });
                res.on('error', () => {
                    client.unbind();
                    return resolve(false);
                });
                res.on('end', () => {
                    if (!userDN) {
                        client.unbind();
                        return resolve(false);
                    }
                    // Try to bind as the user
                    const userClient = ldap.createClient({ url: LDAP_URL });
                    userClient.bind(userDN, password, (err) => {
                        userClient.unbind();
                        resolve(!err);
                    });
                    client.unbind();
                });
            });
        });
    });
}

// Logout command
bot.command('logout', async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    authenticatedUsers.delete(userId);
    userStates.delete(userId);

    await deleteMessages(ctx, userId);
    // Try to delete the /logout command message itself
    if (ctx.message && 'message_id' in ctx.message) {
        try {
            await ctx.deleteMessage(ctx.message.message_id);
        } catch {}
    }
});

// Hear /logout as text
bot.hears('/logout', async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;

    authenticatedUsers.delete(userId);
    userStates.delete(userId);

    await deleteMessages(ctx, userId);
    // Try to delete the /logout message itself
    if (ctx.message && 'message_id' in ctx.message) {
        try {
            await ctx.deleteMessage(ctx.message.message_id);
        } catch {}
    }
});

// Handle text messages based on user state
bot.on('text', async (ctx) => {
    if (!ctx.from) return;
    const userId = ctx.from.id;
    const messageText = ctx.message.text.trim();
    const messageTextTrimmed = messageText.toLowerCase();

    // Replace the debug logging near the top of your bot.on('text') handler
    const state = userStates.get(userId);
    if (state && state.step === 'awaiting_password') {
        // Don't log the message content when a password is expected
        logger.info(`Received password input from ${userId}`);
        logger.info(`Current state for user ${userId}: ${state.step}`);
    } else {
        // Safe to log the message for other states
        logger.info(`Received message from ${userId}: "${messageText}"`);
        logger.info(`Current state for user ${userId}: ${state ? state.step : 'no state'}`);
    }

    // Handle /logout immediately
    if (messageTextTrimmed === '/logout') {
        authenticatedUsers.delete(userId);
        userStates.delete(userId);
        await deleteMessages(ctx, userId);
        if (ctx.message && 'message_id' in ctx.message) {
            try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
        }
        return;
    }

    if (!state) return;

    // Username input
    if (state.step === 'awaiting_username') {
        state.username = messageText;
        state.step = 'awaiting_password';
        
        await trackMessage(ctx, userId, 'Please enter your password:');
        return;
    }

    // Password input + authentication
    if (state.step === 'awaiting_password') {
        state.password = messageText;

        // Use LDAP authentication
        const isAuthenticated = await authenticateLDAP(state.username!, state.password!);
        if (isAuthenticated) {
            logger.info(`User ${userId} authenticated successfully`);
            authenticatedUsers.add(userId);
            state.step = 'selecting_server';
            
            await deleteMessages(ctx, userId);
            
            // Add a small delay
            await new Promise(resolve => setTimeout(resolve, 500));
            
            try {
    await ctx.reply(
        'Authenticated!\n' +
        'Welcome to SGT Linux Team Bot\n\n' +
        'The following application is to assist application owners with day to day tasks, abuse of this application\n' +
        'will be logged and reported and this bot will be shutdown immediately.\n\n'
    );
    await ctx.reply(
        'Select a server:',
        Markup.keyboard(SERVERS.map(s => [s.name]))
            .oneTime()
            .resize()
    );
    logger.info(`Server keyboard sent to user ${userId}`);
} catch (error) {
    logger.error(`Failed to send keyboard: ${error}`);
}
        } else {
            userStates.delete(userId);
            await trackMessage(ctx, userId, 'Authentication failed. Please send /start to try again.');
        }
        return;
    }

    // Server selection
    if (state.step === 'selecting_server') {
        const server = SERVERS.find(s => s.name === messageText);
        if (!server) {
            await trackMessage(ctx, userId, 'Invalid server. Please select a server from the list:');
            return;
        }

        logger.info(`User ${userId} is selecting server: ${messageText}`);
        logger.info(`Server found: ${server.name} (${server.ip})`);

        // Store selected server and its name
        state.selectedServer = server.ip;
        state.selectedServerName = server.name;
        state.step = 'awaiting_sudo_user';

        await trackMessage(ctx, userId, 'Please enter the sudo user you want to use (e.g., webapps, wildfly, willy):', {
            reply_markup: { remove_keyboard: true }
        });
        return;
    }

    // Sudo user input
    if (state.step === 'awaiting_sudo_user') {
        state.sudoUser = messageText;
        state.step = 'selecting_script';
        
        logger.info(`Preparing to show command buttons for server ${state.selectedServerName}`);
        
        try {
            // Create a keyboard with all commands - one command per row
            const commandButtons = SCRIPTS.map(s => [{ text: s.name }]);
            
            // First send a message with the information
            await ctx.reply(`Ready to run commands as ${state.sudoUser} on ${state.selectedServerName || state.selectedServer}:`);
            
            // Now send the keyboard with all commands
            await ctx.reply(
                'Select a command:',
                {
                    reply_markup: {
                        keyboard: commandButtons,
                        resize_keyboard: true,
                        one_time_keyboard: true
                    }
                }
            );
            
            logger.info(`All ${SCRIPTS.length} command buttons sent at once`);
        } catch (error) {
            logger.error(`Failed to send command buttons: ${error}`);
        }
        
        return;
    }

    // Script selection and execution
    if (state.step === 'selecting_script') {
        const script = SCRIPTS.find(s => s.name === messageText);
        if (!script) {
            await trackMessage(ctx, userId, 'Invalid script. Please select a script from the list.');
            return;
        }

        logger.info(`User ${userId} is selecting script: ${messageText}`);

        const serverIp = state.selectedServer;
        const sudoUser = state.sudoUser;
        if (!serverIp || !sudoUser) {
            await trackMessage(ctx, userId, 'Server or sudo user information missing. Please start over with /start');
            userStates.delete(userId);
            return;
        }

        try {
            await trackMessage(ctx, userId, `Running command on ${serverIp}...`);
            
            // Connect using NodeSSH (safely handles credentials)
            logger.info(`Connecting to ${serverIp} as ${state.username}`); // Don't log password
            
            // Use redacted object for potential logging
            const sshConfig = {
                host: serverIp,
                username: state.username,
                password: "[REDACTED]" // For any logging in NodeSSH
            };
            
            // But use actual password for connection
            await ssh.connect({
                host: serverIp,
                username: state.username,
                password: state.password
            });
            
            // Execute the command
            logger.info(`Executing command on ${serverIp} as sudo user: ${sudoUser}`);
            const result = await ssh.execCommand(
                `echo '${script.command}' | sudo su - ${sudoUser}`,
                { execOptions: { pty: true } }
            );
            const output = result.stdout || result.stderr;

            // Show output in chunks if it's large
            if (output.length > 4000) {
                const chunks = [];
                for (let i = 0; i < output.length; i += 4000) {
                    chunks.push(output.substring(i, i + 4000));
                }
                
                for (const chunk of chunks) {
                    await trackMessage(ctx, userId, `\`\`\`\n${chunk}\n\`\`\``);
                }
            } else {
                await trackMessage(ctx, userId, `\`\`\`\n${output}\n\`\`\``);
            }
            ssh.dispose();

            // After script execution, ask if user wants to run more commands
            state.step = 'asking_run_more_commands';

            // Try direct API format instead of using Markup helper
            await ctx.reply('Do you want to run more commands?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Yes' }], 
                        [{ text: 'No' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent Yes/No keyboard in direct format');
        } catch (error) {
            logger.error('Script execution error:', safeErrorMessage(error, state));
            await trackMessage(ctx, userId, `Error executing script: ${safeErrorMessage(error, state)}`);
            
            // Ask if user wants to run more commands
            state.step = 'asking_run_more_commands';
            // Try direct API format for the keyboard
            await ctx.reply('Do you want to run more commands?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Yes' }], 
                        [{ text: 'No' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent Yes/No keyboard in direct format after error');
        }
        return;
    }

    // Handle "Do you want to run more commands?"
    if (state.step === 'asking_run_more_commands') {
        logger.info(`User responded to "Run more commands?": "${messageText}"`);

        if (messageTextTrimmed === 'yes') {
            state.step = 'asking_same_or_different_server';
            
            // Direct API format that works
            await ctx.reply('Do you want to use the same server or a different one?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Same server' }], 
                        [{ text: 'Different server' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent Same/Different server keyboard in direct format');
        } else if (messageTextTrimmed === 'no') {
            state.step = 'asking_logout_or_continue';
            
            // UPDATED: Use the same direct API format here
            await ctx.reply('Do you want to logout or continue?', {
                reply_markup: {
                    keyboard: [
                        [{ text: 'Logout' }], 
                        [{ text: 'Continue' }]
                    ],
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent Logout/Continue keyboard in direct format');
        } else {
            await trackMessage(ctx, userId, 'Please choose a valid option: "Yes" or "No".');
        }
        return;
    }

    // Handle "Do you want to logout or continue?"
    if (state.step === 'asking_logout_or_continue') {
        logger.info(`User responded to "Logout or continue?": "${messageText}"`);
        
        if (messageTextTrimmed === 'logout') {
            // Perform logout
            logger.info(`User ${userId} is logging out and clearing all messages`);
            
            // First delete all tracked messages
            await deleteMessages(ctx, userId);
            
            // Then remove user data
            authenticatedUsers.delete(userId);
            userStates.delete(userId);
            
            // Delete the logout command message itself
            if (ctx.message && 'message_id' in ctx.message) {
                try { await ctx.deleteMessage(ctx.message.message_id); } catch {}
            }
            
            // Send final message and track it for future deletion
            const finalMsg = await ctx.reply('You have been logged out. All messages cleared. Send /start to use the bot again.');
            
            // Optional: Delete the final message after a few seconds
            if (finalMsg && 'message_id' in finalMsg) {
                setTimeout(async () => {
                    try { 
                        await ctx.deleteMessage(finalMsg.message_id); 
                    } catch {}
                }, 5000);
            }
        } else if (messageTextTrimmed === 'continue') {
            // Continue - go back to server selection
            state.step = 'selecting_server';
            state.selectedServer = undefined;
            state.selectedServerName = undefined;
            state.sudoUser = undefined;
            
            logger.info(`User ${userId} continuing with new server selection`);
            
            // Use the direct API format that works with other buttons
            const serverButtons = SERVERS.map(s => [{ text: s.name }]);
            
            await ctx.reply('Select a server:', {
                reply_markup: {
                    keyboard: serverButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent server selection keyboard in direct format');
        } else {
            await trackMessage(ctx, userId, 'Please choose a valid option: "Logout" or "Continue".');
        }
        return;
    }

    // Handle "Same server or different server"
    if (state.step === 'asking_same_or_different_server') {
        logger.info(`User responded to "Same or different server?": "${messageText}"`);

        // REMOVE THIS LINE - it's causing the error by sending a space as text
        // await ctx.reply(' ', { reply_markup: { remove_keyboard: true } });

        // The keyboard comes with the next message anyway, so we don't need the separate removal

        if (messageTextTrimmed === 'same server') {
            state.step = 'awaiting_sudo_user';
            logger.info(`User ${userId} continuing with same server: ${state.selectedServerName}`);

            await trackMessage(
                ctx,
                userId,
                'Please enter the sudo user you want to use (e.g., webapps, wildfly, willy):',
                {
                    reply_markup: { remove_keyboard: true }
                }
            );
        } else if (messageTextTrimmed === 'different server') {
            state.step = 'selecting_server';
            state.selectedServer = undefined;
            state.selectedServerName = undefined;
            state.sudoUser = undefined;

            logger.info(`User ${userId} switching to a different server`);
            
            // Use the direct API format that works with other buttons
            const serverButtons = SERVERS.map(s => [{ text: s.name }]);
            
            await ctx.reply('Select a server:', {
                reply_markup: {
                    keyboard: serverButtons,
                    resize_keyboard: true,
                    one_time_keyboard: true
                }
            });
            logger.info('Sent server selection keyboard in direct format');
        } else if (
            messageTextTrimmed !== 'same server' &&
            messageTextTrimmed !== 'different server'
        ) {
            // Do nothing, just wait for a valid response
            return;
        }
        return;
    }
});

// 2. Add a safer error handling function that won't expose passwords
function safeErrorMessage(error: any, state?: UserState): string {
    if (!error) return 'Unknown error';
    
    let message = error instanceof Error ? error.message : String(error);
    
    // Redact common password patterns
    message = message.replace(/password=['"][^'"]*[']/gi, "password='[REDACTED]'");
    message = message.replace(/password=[^&\s]+/gi, "password=[REDACTED]");
    
    // Also redact the actual password if it appears anywhere
    if (state && state.password) {
        message = message.replace(new RegExp(state.password, 'g'), '[REDACTED]');
    }
    
    return message;
}

// 3. Add this warning at the start of your script
logger.warn('WARNING: For security, ensure NODE_SSH_NO_DEBUG=1 is set in production to prevent credential logging');

// Launch the bot with proper error handling
try {
  logger.info('Attempting to launch bot...');
  bot.launch();
  logger.info('Bot launched successfully!');
  
  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} catch (error) {
  logger.error('Failed to launch bot:', error);
}