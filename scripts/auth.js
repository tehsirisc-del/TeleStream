require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input');
const fs = require('fs');
const path = require('path');

const apiId = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

if (!apiId || !apiHash) {
  console.error('Error: TG_API_ID and TG_API_HASH must be provided in the .env file.');
  console.error('You can get these from https://my.telegram.org');
  process.exit(1);
}

const stringSession = new StringSession(''); // Empty string means creating a new session

async function authenticate() {
  console.log('Loading interactive Telegram login...');
  
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => await input.text('Please enter your phone number (with country code, e.g., +1234567890): '),
    password: async () => await input.text('Please enter your 2FA password (leave blank if none): '),
    phoneCode: async () => await input.text('Please enter the OTP code you received: '),
    onError: (err) => console.log('Login error:', err),
  });

  console.log('\n--- Login Successful! ---');
  
  const sessionString = client.session.save();
  console.log('\nYour session string is (also saving to .env):');
  console.log(sessionString);

  // Append or update the session string in the .env file
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }

  if (envContent.includes('TG_SESSION=')) {
    // Replace existing session string if present
    envContent = envContent.replace(/TG_SESSION=.*/g, `TG_SESSION=${sessionString}`);
  } else {
    // Append it
    envContent += `\nTG_SESSION=${sessionString}\n`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log('\nSession saved to .env file! You can now start the server.');
  
  await client.disconnect();
}

authenticate();
