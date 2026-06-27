-- Add missing broker configs
INSERT INTO broker_configs (name, type, market, emoji, instructions, website_url, requires_api_key, requires_secret, requires_passphrase, requires_mt_login, is_active, is_manual) VALUES
('Fyers', 'Indian Stock Broker', 'indian', '🏦', 'Client ID -> API Key field, daily Access Token (from myapi.fyers.in) -> Secret field', 'https://fyers.in', true, true, false, false, true, false),
('Dhan', 'Indian Stock Broker', 'indian', '🏦', 'Dhan Client ID -> API Key field, Access Token (DhanHQ Trading APIs section) -> Secret field', 'https://dhan.co', true, true, false, false, true, false),
('Finvasia (Shoonya)', 'Indian Stock Broker', 'indian', '🏦', 'User ID -> API Key, App Key -> Secret, TOTP Secret -> Passphrase', 'https://shoonya.com', true, true, true, false, true, false),
('Alice Blue', 'Indian Stock Broker', 'indian', '🏦', 'User ID -> API Key, App Code/API Key -> Secret', 'https://aliceblueonline.com', true, true, false, false, true, false),
('Pocketful', 'Indian Stock Broker', 'indian', '🏦', 'Client ID -> API Key, API Secret -> Secret', 'https://pocketful.in', true, true, false, false, true, false),
('Samco', 'Indian Stock Broker', 'indian', '🏦', 'User ID -> API Key, Password -> Secret, Year of Birth -> Passphrase', 'https://samco.in', true, true, true, false, true, false),
('Kotak Neo', 'Indian Stock Broker', 'indian', '🏦', 'Consumer Key -> API Key, Consumer Secret -> Secret, MPIN -> Passphrase', 'https://neo.kotaksecurities.com', true, true, true, false, true, false),
('Gate.io', 'Crypto Exchange', 'crypto', '🏦', 'Standard API Key + Secret from API Management', 'https://www.gate.io', true, true, false, false, true, false),
('Kraken', 'Crypto Exchange', 'crypto', '🏦', 'API Key + Private Key from Kraken Security settings', 'https://www.kraken.com', true, true, false, false, true, false),
('MEXC', 'Crypto Exchange', 'crypto', '🏦', 'API Key + Secret from API Management', 'https://www.mexc.com', true, true, false, false, true, false),
('BingX', 'Crypto Exchange', 'crypto', '🏦', 'API Key + Secret from API Management', 'https://bingx.com', true, true, false, false, true, false),
('Bitfinex', 'Crypto Exchange', 'crypto', '🏦', 'API Key + Secret from API Management', 'https://www.bitfinex.com', true, true, false, false, true, false),
('HTX (Huobi)', 'Crypto Exchange', 'crypto', '🏦', 'Access Key + Secret Key', 'https://www.htx.com', true, true, false, false, true, false),
('Crypto.com', 'Crypto Exchange', 'crypto', '🏦', 'API Key + Secret from Exchange API settings', 'https://crypto.com/exchange', true, true, false, false, true, false),
('Deriv', 'Forex Broker', 'forex', '🏦', 'Sirf API Token chahiye -> API Key field mein paste karo', 'https://deriv.com', true, false, false, false, true, false),
('CoinDCX', 'Indian Crypto', 'crypto', '🏦', 'API Key + Secret from API Settings', 'https://coindcx.com', true, true, false, false, true, false),
('WazirX', 'Indian Crypto', 'crypto', '🏦', 'API Key + Secret. Note: platform had a 2024 security incident, mention this caution in instructions text shown to user.', 'https://wazirx.com', true, true, false, false, true, false);
