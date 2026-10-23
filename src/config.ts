export const APP_NAME = 'Belroll';
export const NETWORK = 'testnet' as const;
export const WALLET_INSTALL_URL = 'https://chromewebstore.google.com/detail/beldex-wallet/onhnehjhhionmnbidajneakngpiefapa';

/**
 * TODO(privacy-token): @bdxi/web3js@1.0.1 exports no token-send method or
 * tokenId parameter (SendTransactionParams / BDX_METHODS inspected).
 * Keep this unset until a real SDK API and a requester-owned testnet token ID
 * are supplied. Do not put a token ID into paymentId: that is a different API.
 */
export const PRIVACY_TOKEN_ID: string | null = null;
export const SEND_ASSET = 'BDX' as const;
export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_ROWS = 500;
// Stay well inside the wallet's documented approximately 24-hour recovery TTL.
export const RECOVERY_WINDOW_MS = 12 * 60 * 60 * 1000;
export const JOURNAL_KEY = 'belroll.journal.v1';
