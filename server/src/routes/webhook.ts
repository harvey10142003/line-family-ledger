import { Router, type Request, type Response } from 'express';
import type { WebhookEvent, MessageEvent, TextEventMessage, ImageEventMessage } from '@line/bot-sdk';
import { verifyLineSignature } from '../line/client';
import { logger } from '../logger';
import { handleFollow } from '../line/handlers/follow';
import { handlePostback } from '../line/handlers/postback';
import { handleTextMessage } from '../line/handlers/message-text';
import { handleImageMessage } from '../line/handlers/message-image';

export const webhookRouter = Router();

webhookRouter.post('/', async (req: Request, res: Response) => {
  const signature = req.header('x-line-signature') ?? '';
  const rawBody = (req.body as Buffer).toString('utf-8');

  if (!verifyLineSignature(rawBody, signature)) {
    logger.warn('invalid LINE signature');
    res.status(401).end();
    return;
  }

  // LINE 要求 webhook 在 1s 內回 200，先回應再處理
  res.status(200).end();

  let body: { events: WebhookEvent[] };
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    logger.error({ err: e }, 'invalid webhook json');
    return;
  }

  for (const event of body.events) {
    void dispatch(event).catch((err) =>
      logger.error({ err, event }, 'webhook dispatch failed'),
    );
  }
});

async function dispatch(event: WebhookEvent): Promise<void> {
  switch (event.type) {
    case 'follow':
      return handleFollow(event);
    case 'postback':
      return handlePostback(event);
    case 'message': {
      if (event.message.type === 'text') {
        return handleTextMessage(event as MessageEvent & { message: TextEventMessage });
      }
      if (event.message.type === 'image') {
        return handleImageMessage(event as MessageEvent & { message: ImageEventMessage });
      }
      return;
    }
    default:
      logger.debug({ type: event.type }, 'unhandled event');
  }
}
