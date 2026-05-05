import { messagingApi, validateSignature } from '@line/bot-sdk';
import { config } from '../config';

export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

export const lineBlobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.line.channelAccessToken,
});

export function verifyLineSignature(rawBody: string, signature: string): boolean {
  return validateSignature(rawBody, config.line.channelSecret, signature);
}
