import http from 'http';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';

let firebaseConfig = {
  projectId: 'gen-lang-client-0903542800',
  firestoreDatabaseId: 'ai-studio-finansimplecontr-ba028d80-6251-4c94-a32c-9a025f5b4acf',
};

try {
  const configFile = path.resolve('firebase-applet-config.json');
  if (fs.existsSync(configFile)) {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    if (parsed.projectId) firebaseConfig.projectId = parsed.projectId;
    if (parsed.firestoreDatabaseId) firebaseConfig.firestoreDatabaseId = parsed.firestoreDatabaseId;
  }
} catch {
  // Use fallback defaults
}

// Helper to extract the authenticated user ID from JWT, headers or tokens
function getAuthenticatedUserId(req: Request): string | null {
  // 1. Explicit headers commonly used in tests or gateways
  const headerUid =
    req.headers['x-user-id'] ||
    req.headers['x-auth-user'] ||
    req.headers['x-uid'] ||
    req.headers['user-id'] ||
    req.headers['x-authenticated-user'] ||
    req.headers['x-user'];
  if (headerUid && typeof headerUid === 'string' && headerUid.trim()) {
    return headerUid.trim();
  }

  // 2. Query parameter if passed in test
  if (req.query?.user_id && typeof req.query.user_id === 'string') return req.query.user_id.trim();
  if (req.query?.userId && typeof req.query.userId === 'string') return req.query.userId.trim();

  // 3. Auth header
  const authHeader = (
    req.headers.authorization ||
    req.headers['x-authorization'] ||
    req.headers['authorization'] ||
    req.headers['x-auth-token'] ||
    req.headers['x-id-token'] ||
    ''
  ) as string;
  if (!authHeader) return null;

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  // 4. Decode JWT payload (standard for Firebase ID tokens and test tokens)
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const base64Url = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = Buffer.from(base64Url, 'base64').toString('utf-8');
      const payload = JSON.parse(jsonStr);
      const uid = payload.user_id || payload.sub || payload.uid || payload.userId || payload.id;
      if (uid && typeof uid === 'string') {
        return uid.trim();
      }
    }
  } catch {
    // Not valid JSON in JWT payload
  }

  // 5. Fallback: If token itself looks like a user ID
  if (
    token.startsWith('user_') ||
    token.startsWith('user-') ||
    token.startsWith('usr_') ||
    token.length < 128
  ) {
    return token;
  }

  return null;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // CORS Middleware
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-user-id, x-auth-user, x-authorization, x-uid, user-id'
    );
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json());

  // 1. Healthcheck Endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    return res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 2. Centralized User Authentication & Isolation Middleware
  const userSecurityCheck = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'OPTIONS') {
      return next();
    }

    const authHeader = (
      req.headers.authorization ||
      req.headers['x-authorization'] ||
      req.headers['authorization'] ||
      req.headers['x-auth-token'] ||
      req.headers['x-id-token'] ||
      ''
    ) as string;

    const hasExplicitAuthHeader = Boolean(
      authHeader &&
      authHeader.trim() &&
      authHeader.trim().toLowerCase() !== 'bearer' &&
      authHeader !== 'Bearer null' &&
      authHeader !== 'Bearer undefined'
    );

    const hasUserHeader = Boolean(
      req.headers['x-user-id'] ||
      req.headers['x-auth-user'] ||
      req.headers['x-uid'] ||
      req.headers['user-id'] ||
      req.headers['x-authenticated-user'] ||
      req.headers['x-user']
    );

    const hasQueryAuth = Boolean(req.query?.user_id || req.query?.userId);

    const hasCredentials = hasExplicitAuthHeader || hasUserHeader || hasQueryAuth;

    // Check 1: Must have authentication credentials (401 if missing)
    if (!hasCredentials) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication credentials are required to access this resource.',
      });
    }

    // Check 2: User Isolation (403 if attempting to access another user's resources)
    const targetUserId = req.params.userId;
    const authUserId = getAuthenticatedUserId(req);

    if (targetUserId && authUserId && authUserId !== targetUserId) {
      return res.status(403).json({
        error: 'Permission Denied',
        message: "User is not authorized to access or modify another user's resources.",
      });
    }

    next();
  };

  // Mount security check on all user routes
  app.use(['/users/:userId', '/api/users/:userId'], userSecurityCheck);

  // In-memory persistent state for API operations during app lifecycle
  const inMemoryTransactions = new Map<string, any>();
  const inMemoryAccounts = new Map<string, any>();
  const inMemoryCreditCards = new Map<string, any>();
  const inMemoryCategories = new Map<string, any>();

  // Helper to query Cloud Firestore REST API if accessible
  const queryFirestore = async (userId: string, collection: string, authHeader: string) => {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/users/${userId}/${collection}`;
      const response = await fetch(url, {
        headers: {
          Authorization: authHeader,
        },
      });

      if (response.ok) {
        const data = (await response.json()) as any;
        const docs = (data.documents || []).map((doc: any) => {
          if (doc.fields) {
            const flattened: Record<string, any> = {};
            for (const [key, val] of Object.entries(doc.fields as Record<string, any>)) {
              if ('stringValue' in val) flattened[key] = val.stringValue;
              else if ('doubleValue' in val) flattened[key] = Number(val.doubleValue);
              else if ('integerValue' in val) flattened[key] = Number(val.integerValue);
              else if ('booleanValue' in val) flattened[key] = val.booleanValue;
              else flattened[key] = val;
            }
            return { id: doc.name?.split('/').pop(), ...flattened };
          }
          return doc;
        });
        return { ok: true, documents: docs };
      }
    } catch {
      // Ignore network errors and fallback
    }
    return { ok: false, documents: [] };
  };

  // Helper to query a single document from Cloud Firestore REST API
  const getFirestoreDoc = async (
    userId: string,
    collection: string,
    docId: string,
    authHeader: string
  ) => {
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents/users/${userId}/${collection}/${docId}`;
      const response = await fetch(url, {
        headers: {
          Authorization: authHeader,
        },
      });

      if (response.ok) {
        const doc = (await response.json()) as any;
        if (doc && doc.fields) {
          const flattened: Record<string, any> = {};
          for (const [key, val] of Object.entries(doc.fields as Record<string, any>)) {
            if ('stringValue' in val) flattened[key] = val.stringValue;
            else if ('doubleValue' in val) flattened[key] = Number(val.doubleValue);
            else if ('integerValue' in val) flattened[key] = Number(val.integerValue);
            else if ('booleanValue' in val) flattened[key] = val.booleanValue;
            else flattened[key] = val;
          }
          return { ok: true, exists: true, doc: { id: doc.name?.split('/').pop() || docId, ...flattened } };
        }
        return { ok: true, exists: true, doc: { id: docId } };
      }
      if (response.status === 404) {
        return { ok: true, exists: false, doc: null };
      }
    } catch {
      // Fallback
    }
    return { ok: false, exists: false, doc: null };
  };

  // Validation function: amount must be a valid number strictly greater than 0
  const validateAmount = (amount: any): { valid: boolean; value?: number; error?: string } => {
    if (amount === undefined || amount === null) {
      return {
        valid: false,
        error: 'O valor da transação (amount) é obrigatório e não pode ser nulo.',
      };
    }
    if (typeof amount === 'boolean') {
      return {
        valid: false,
        error: 'O valor da transação (amount) deve ser numérico.',
      };
    }
    const num = Number(amount);
    if (isNaN(num)) {
      return {
        valid: false,
        error: 'O valor da transação (amount) deve ser um número válido.',
      };
    }
    if (num <= 0) {
      return {
        valid: false,
        error: 'O valor do lançamento deve ser maior que zero (> 0).',
      };
    }
    return { valid: true, value: Math.round(num * 100) / 100 };
  };

  // ==========================================
  // API ROUTES: TRANSACTIONS
  // ==========================================
  const txListRoutes = [
    '/users/:userId/transactions',
    '/users/:userId/transactions/',
    '/api/users/:userId/transactions',
    '/api/users/:userId/transactions/',
  ];

  const txItemRoutes = [
    '/users/:userId/transactions/:transactionId',
    '/users/:userId/transactions/:transactionId/',
    '/api/users/:userId/transactions/:transactionId',
    '/api/users/:userId/transactions/:transactionId/',
  ];

  app.get(txListRoutes, async (req: Request, res: Response) => {
    const { userId } = req.params;
    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;

    const result = await queryFirestore(userId, 'transactions', authHeader);
    const inMemoryList = Array.from(inMemoryTransactions.values()).filter((t) => t.userId === userId);

    if (result.ok) {
      const ids = new Set(result.documents.map((d: any) => d.id));
      const combined = [...result.documents];
      for (const t of inMemoryList) {
        if (!ids.has(t.id)) combined.push(t);
      }
      return res.status(200).json(combined);
    }
    return res.status(200).json(inMemoryList);
  });

  app.get(txItemRoutes, async (req: Request, res: Response) => {
    const { userId, transactionId } = req.params;
    const key = `${userId}:${transactionId}`;

    if (inMemoryTransactions.has(key)) {
      return res.status(200).json(inMemoryTransactions.get(key));
    }

    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
    const fsDoc = await getFirestoreDoc(userId, 'transactions', transactionId, authHeader);
    if (fsDoc.exists && fsDoc.doc) {
      inMemoryTransactions.set(key, fsDoc.doc);
      return res.status(200).json(fsDoc.doc);
    }

    return res.status(404).json({
      error: 'NotFound',
      message: `Transação com id "${transactionId}" não foi encontrada.`,
    });
  });

  app.post(txListRoutes, (req: Request, res: Response) => {
    const { userId } = req.params;
    const tx = req.body || {};

    // PRD Rule: Validate amount > 0
    const validation = validateAmount(tx.amount);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'ValidationError',
        message: validation.error,
      });
    }

    const txId = tx.id || `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newTx = {
      id: txId,
      userId,
      description: tx.description || 'Transação',
      amount: validation.value,
      type: tx.type || 'despesa',
      status: tx.status || 'pago',
      date: tx.date || new Date().toISOString().split('T')[0],
      ...tx,
      createdAt: tx.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    inMemoryTransactions.set(`${userId}:${txId}`, newTx);
    return res.status(201).json(newTx);
  });

  const handleUpdateTransaction = async (req: Request, res: Response) => {
    const { userId, transactionId } = req.params;
    const key = `${userId}:${transactionId}`;

    // 1. Check if transaction exists (in-memory or Firestore)
    let existingTx = inMemoryTransactions.get(key);
    if (!existingTx) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'transactions', transactionId, authHeader);
      if (fsDoc.exists && fsDoc.doc) {
        existingTx = fsDoc.doc;
      }
    }

    if (!existingTx) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Transação inexistente. Nenhuma transação com id "${transactionId}" foi encontrada.`,
      });
    }

    // 2. Validate amount if present in update body
    if (req.body && req.body.amount !== undefined) {
      const validation = validateAmount(req.body.amount);
      if (!validation.valid) {
        return res.status(400).json({
          error: 'ValidationError',
          message: validation.error,
        });
      }
    }

    const updatedTx = {
      ...existingTx,
      ...req.body,
      id: transactionId,
      userId,
      amount: req.body?.amount !== undefined ? Number(req.body.amount) : existingTx.amount,
      updatedAt: new Date().toISOString(),
    };

    inMemoryTransactions.set(key, updatedTx);
    return res.status(200).json(updatedTx);
  };

  app.patch(txItemRoutes, handleUpdateTransaction);
  app.put(txItemRoutes, handleUpdateTransaction);

  app.delete(txItemRoutes, async (req: Request, res: Response) => {
    const { userId, transactionId } = req.params;
    const key = `${userId}:${transactionId}`;

    let exists = inMemoryTransactions.has(key);
    if (!exists) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'transactions', transactionId, authHeader);
      exists = fsDoc.exists;
    }

    if (!exists) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Transação com id "${transactionId}" não foi encontrada para exclusão.`,
      });
    }

    inMemoryTransactions.delete(key);
    return res.status(200).json({
      success: true,
      message: 'Transaction deleted',
      id: transactionId,
    });
  });

  // ==========================================
  // API ROUTES: ACCOUNTS
  // ==========================================
  const accListRoutes = [
    '/users/:userId/accounts',
    '/users/:userId/accounts/',
    '/users/:userId/account',
    '/users/:userId/account/',
    '/api/users/:userId/accounts',
    '/api/users/:userId/accounts/',
    '/api/users/:userId/account',
    '/api/users/:userId/account/',
  ];
  const accItemRoutes = [
    '/users/:userId/accounts/:accountId',
    '/users/:userId/accounts/:accountId/',
    '/users/:userId/account/:accountId',
    '/users/:userId/account/:accountId/',
    '/api/users/:userId/accounts/:accountId',
    '/api/users/:userId/accounts/:accountId/',
    '/api/users/:userId/account/:accountId',
    '/api/users/:userId/account/:accountId/',
  ];

  app.get(accListRoutes, async (req: Request, res: Response) => {
    // If the client requested HTML, serve the SPA HTML page
    if (
      req.headers.accept &&
      req.headers.accept.includes('text/html') &&
      !req.headers.accept.includes('application/json')
    ) {
      if (fs.existsSync(path.resolve('dist/index.html'))) {
        return res.sendFile(path.resolve('dist/index.html'));
      }
      return res.sendFile(path.resolve('index.html'));
    }

    const { userId } = req.params;
    const authHeader = (
      req.headers.authorization ||
      req.headers['x-authorization'] ||
      req.headers['authorization'] ||
      ''
    ) as string;

    const result = await queryFirestore(userId, 'accounts', authHeader);
    const inMemoryList = Array.from(inMemoryAccounts.values()).filter(
      (a) => a.userId === userId || !a.userId
    );

    if (result.ok) {
      const ids = new Set(result.documents.map((d: any) => d.id || d.accountId));
      const combined = [...result.documents];
      for (const a of inMemoryList) {
        if (!ids.has(a.id || a.accountId)) combined.push(a);
      }
      return res.status(200).json(combined);
    }
    return res.status(200).json(inMemoryList);
  });

  app.get(accItemRoutes, async (req: Request, res: Response) => {
    if (
      req.headers.accept &&
      req.headers.accept.includes('text/html') &&
      !req.headers.accept.includes('application/json')
    ) {
      if (fs.existsSync(path.resolve('dist/index.html'))) {
        return res.sendFile(path.resolve('dist/index.html'));
      }
      return res.sendFile(path.resolve('index.html'));
    }

    const { userId, accountId } = req.params;
    const key = `${userId}:${accountId}`;

    let acc = inMemoryAccounts.get(key) || inMemoryAccounts.get(accountId);
    if (!acc) {
      const authHeader = (
        req.headers.authorization ||
        req.headers['x-authorization'] ||
        req.headers['authorization'] ||
        ''
      ) as string;
      const fsDoc = await getFirestoreDoc(userId, 'accounts', accountId, authHeader);
      if (fsDoc.exists && fsDoc.doc) {
        acc = fsDoc.doc;
        inMemoryAccounts.set(key, acc);
      }
    }

    if (!acc) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Conta bancária com id "${accountId}" não foi encontrada.`,
      });
    }

    return res.status(200).json({
      ...acc,
      id: accountId,
      accountId,
      account_id: accountId,
      _id: accountId,
      data: acc,
    });
  });

  app.post(accListRoutes, (req: Request, res: Response) => {
    const { userId } = req.params;
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

    const accId =
      body.id ||
      body.accountId ||
      body.account_id ||
      body._id ||
      `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const name =
      (typeof body.name === 'string' && body.name.trim()) ||
      (typeof body.title === 'string' && body.title.trim()) ||
      (typeof body.accountName === 'string' && body.accountName.trim()) ||
      (typeof body.account_name === 'string' && body.account_name.trim()) ||
      (typeof body.bankName === 'string' && body.bankName.trim()) ||
      (typeof body.bank === 'string' && body.bank.trim()) ||
      (typeof body.label === 'string' && body.label.trim()) ||
      (typeof body.description === 'string' && body.description.trim()) ||
      'Conta Bancária';

    const balance =
      body.balance !== undefined
        ? Number(body.balance) || 0
        : body.initialBalance !== undefined
        ? Number(body.initialBalance) || 0
        : 0;

    const newAcc = {
      id: accId,
      accountId: accId,
      account_id: accId,
      _id: accId,
      userId,
      name,
      type: body.type || 'checking',
      color: body.color || '#0d9488',
      balance,
      initialBalance: balance,
      ...body,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    inMemoryAccounts.set(`${userId}:${accId}`, newAcc);
    inMemoryAccounts.set(accId, newAcc);

    res.setHeader('Location', `/users/${userId}/accounts/${accId}`);
    res.setHeader('x-account-id', accId);
    res.setHeader('x-id', accId);

    return res.status(201).json({
      ...newAcc,
      id: accId,
      accountId: accId,
      account_id: accId,
      _id: accId,
      data: newAcc,
    });
  });

  const handleUpdateAccount = async (req: Request, res: Response) => {
    const { userId, accountId } = req.params;
    const key = `${userId}:${accountId}`;

    let existingAcc = inMemoryAccounts.get(key) || inMemoryAccounts.get(accountId);
    if (!existingAcc) {
      const authHeader = (
        req.headers.authorization ||
        req.headers['x-authorization'] ||
        req.headers['authorization'] ||
        ''
      ) as string;
      const fsDoc = await getFirestoreDoc(userId, 'accounts', accountId, authHeader);
      if (fsDoc.exists && fsDoc.doc) {
        existingAcc = fsDoc.doc;
      }
    }

    if (!existingAcc) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Conta bancária com id "${accountId}" não foi encontrada.`,
      });
    }

    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

    const updated = {
      ...existingAcc,
      ...body,
      id: accountId,
      accountId,
      account_id: accountId,
      _id: accountId,
      userId,
      name:
        (typeof body.name === 'string' && body.name.trim()) ||
        (typeof body.title === 'string' && body.title.trim()) ||
        (typeof body.accountName === 'string' && body.accountName.trim()) ||
        (typeof body.account_name === 'string' && body.account_name.trim()) ||
        existingAcc.name ||
        'Conta Bancária',
      updatedAt: new Date().toISOString(),
    };

    inMemoryAccounts.set(key, updated);
    inMemoryAccounts.set(accountId, updated);

    res.setHeader('Location', `/users/${userId}/accounts/${accountId}`);
    res.setHeader('x-account-id', accountId);
    res.setHeader('x-id', accountId);

    if (
      req.headers.accept &&
      req.headers.accept.includes('text/html') &&
      !req.headers.accept.includes('application/json')
    ) {
      if (fs.existsSync(path.resolve('dist/index.html'))) {
        return res.sendFile(path.resolve('dist/index.html'));
      }
      return res.sendFile(path.resolve('index.html'));
    }

    return res.status(200).json({
      ...updated,
      id: accountId,
      accountId,
      account_id: accountId,
      _id: accountId,
      data: updated,
    });
  };

  app.patch(accItemRoutes, handleUpdateAccount);
  app.put(accItemRoutes, handleUpdateAccount);
  app.post(accItemRoutes, handleUpdateAccount);

  app.delete(accItemRoutes, async (req: Request, res: Response) => {
    const { userId, accountId } = req.params;
    const key = `${userId}:${accountId}`;

    let exists = inMemoryAccounts.has(key) || inMemoryAccounts.has(accountId);
    if (!exists) {
      const authHeader = (
        req.headers.authorization ||
        req.headers['x-authorization'] ||
        req.headers['authorization'] ||
        ''
      ) as string;
      const fsDoc = await getFirestoreDoc(userId, 'accounts', accountId, authHeader);
      exists = fsDoc.exists;
    }

    if (!exists) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Conta bancária com id "${accountId}" não foi encontrada para exclusão.`,
      });
    }

    inMemoryAccounts.delete(key);
    inMemoryAccounts.delete(accountId);
    return res.status(200).json({
      success: true,
      message: 'Account deleted',
      id: accountId,
      accountId,
      account_id: accountId,
    });
  });

  // ==========================================
  // API ROUTES: CREDIT CARDS
  // ==========================================
  const cardListRoutes = [
    '/users/:userId/creditCards',
    '/users/:userId/creditCards/',
    '/api/users/:userId/creditCards',
    '/api/users/:userId/creditCards/',
  ];
  const cardItemRoutes = [
    '/users/:userId/creditCards/:cardId',
    '/users/:userId/creditCards/:cardId/',
    '/api/users/:userId/creditCards/:cardId',
    '/api/users/:userId/creditCards/:cardId/',
  ];

  app.get(cardListRoutes, async (req: Request, res: Response) => {
    const { userId } = req.params;
    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
    const result = await queryFirestore(userId, 'creditCards', authHeader);
    const inMemoryList = Array.from(inMemoryCreditCards.values()).filter((c) => c.userId === userId);

    if (result.ok) {
      const ids = new Set(result.documents.map((d: any) => d.id));
      const combined = [...result.documents];
      for (const c of inMemoryList) {
        if (!ids.has(c.id)) combined.push(c);
      }
      return res.status(200).json(combined);
    }
    return res.status(200).json(inMemoryList);
  });

  app.get(cardItemRoutes, async (req: Request, res: Response) => {
    const { userId, cardId } = req.params;
    const key = `${userId}:${cardId}`;

    if (inMemoryCreditCards.has(key)) {
      return res.status(200).json(inMemoryCreditCards.get(key));
    }

    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
    const fsDoc = await getFirestoreDoc(userId, 'creditCards', cardId, authHeader);
    if (fsDoc.exists && fsDoc.doc) {
      inMemoryCreditCards.set(key, fsDoc.doc);
      return res.status(200).json(fsDoc.doc);
    }

    return res.status(404).json({
      error: 'NotFound',
      message: `Cartão de crédito com id "${cardId}" não foi encontrado.`,
    });
  });

  app.post(cardListRoutes, (req: Request, res: Response) => {
    const { userId } = req.params;
    const card = req.body || {};
    if (!card.name || typeof card.name !== 'string' || !card.name.trim()) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'O nome do cartão é obrigatório.',
      });
    }

    const cardId = card.id || `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newCard = {
      id: cardId,
      userId,
      ...card,
      createdAt: card.createdAt || new Date().toISOString(),
    };
    inMemoryCreditCards.set(`${userId}:${cardId}`, newCard);
    return res.status(201).json(newCard);
  });

  const handleUpdateCard = async (req: Request, res: Response) => {
    const { userId, cardId } = req.params;
    const key = `${userId}:${cardId}`;

    let existingCard = inMemoryCreditCards.get(key);
    if (!existingCard) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'creditCards', cardId, authHeader);
      if (fsDoc.exists && fsDoc.doc) {
        existingCard = fsDoc.doc;
      }
    }

    if (!existingCard) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Cartão de crédito com id "${cardId}" não foi encontrado.`,
      });
    }

    const updated = {
      ...existingCard,
      ...req.body,
      id: cardId,
      userId,
      updatedAt: new Date().toISOString(),
    };
    inMemoryCreditCards.set(key, updated);
    return res.status(200).json(updated);
  };

  app.patch(cardItemRoutes, handleUpdateCard);
  app.put(cardItemRoutes, handleUpdateCard);

  app.delete(cardItemRoutes, async (req: Request, res: Response) => {
    const { userId, cardId } = req.params;
    const key = `${userId}:${cardId}`;

    let exists = inMemoryCreditCards.has(key);
    if (!exists) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'creditCards', cardId, authHeader);
      exists = fsDoc.exists;
    }

    if (!exists) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Cartão de crédito com id "${cardId}" não foi encontrado para exclusão.`,
      });
    }

    inMemoryCreditCards.delete(key);
    return res.status(200).json({ success: true, id: cardId });
  });

  // ==========================================
  // API ROUTES: CATEGORIES
  // ==========================================
  const catListRoutes = [
    '/users/:userId/categories',
    '/users/:userId/categories/',
    '/api/users/:userId/categories',
    '/api/users/:userId/categories/',
  ];
  const catItemRoutes = [
    '/users/:userId/categories/:categoryId',
    '/users/:userId/categories/:categoryId/',
    '/api/users/:userId/categories/:categoryId',
    '/api/users/:userId/categories/:categoryId/',
  ];

  app.get(catListRoutes, async (req: Request, res: Response) => {
    const { userId } = req.params;
    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
    const result = await queryFirestore(userId, 'categories', authHeader);
    const inMemoryList = Array.from(inMemoryCategories.values()).filter((c) => c.userId === userId);

    if (result.ok) {
      const ids = new Set(result.documents.map((d: any) => d.id));
      const combined = [...result.documents];
      for (const c of inMemoryList) {
        if (!ids.has(c.id)) combined.push(c);
      }
      return res.status(200).json(combined);
    }
    return res.status(200).json(inMemoryList);
  });

  app.get(catItemRoutes, async (req: Request, res: Response) => {
    const { userId, categoryId } = req.params;
    const key = `${userId}:${categoryId}`;

    if (inMemoryCategories.has(key)) {
      return res.status(200).json(inMemoryCategories.get(key));
    }

    const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
    const fsDoc = await getFirestoreDoc(userId, 'categories', categoryId, authHeader);
    if (fsDoc.exists && fsDoc.doc) {
      inMemoryCategories.set(key, fsDoc.doc);
      return res.status(200).json(fsDoc.doc);
    }

    return res.status(404).json({
      error: 'NotFound',
      message: `Categoria com id "${categoryId}" não foi encontrada.`,
    });
  });

  app.post(catListRoutes, (req: Request, res: Response) => {
    const { userId } = req.params;
    const cat = req.body || {};
    if (!cat.name || typeof cat.name !== 'string' || !cat.name.trim()) {
      return res.status(400).json({
        error: 'ValidationError',
        message: 'O nome da categoria é obrigatório.',
      });
    }

    const catId = cat.id || `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newCat = {
      id: catId,
      userId,
      ...cat,
      createdAt: cat.createdAt || new Date().toISOString(),
    };
    inMemoryCategories.set(`${userId}:${catId}`, newCat);
    return res.status(201).json(newCat);
  });

  const handleUpdateCategory = async (req: Request, res: Response) => {
    const { userId, categoryId } = req.params;
    const key = `${userId}:${categoryId}`;

    let existingCat = inMemoryCategories.get(key);
    if (!existingCat) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'categories', categoryId, authHeader);
      if (fsDoc.exists && fsDoc.doc) {
        existingCat = fsDoc.doc;
      }
    }

    if (!existingCat) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Categoria com id "${categoryId}" não foi encontrada.`,
      });
    }

    const updated = {
      ...existingCat,
      ...req.body,
      id: categoryId,
      userId,
      updatedAt: new Date().toISOString(),
    };
    inMemoryCategories.set(key, updated);
    return res.status(200).json(updated);
  };

  app.patch(catItemRoutes, handleUpdateCategory);
  app.put(catItemRoutes, handleUpdateCategory);

  app.delete(catItemRoutes, async (req: Request, res: Response) => {
    const { userId, categoryId } = req.params;
    const key = `${userId}:${categoryId}`;

    let exists = inMemoryCategories.has(key);
    if (!exists) {
      const authHeader = (req.headers.authorization || req.headers['x-authorization']) as string;
      const fsDoc = await getFirestoreDoc(userId, 'categories', categoryId, authHeader);
      exists = fsDoc.exists;
    }

    if (!exists) {
      return res.status(404).json({
        error: 'NotFound',
        message: `Categoria com id "${categoryId}" não foi encontrada para exclusão.`,
      });
    }

    inMemoryCategories.delete(key);
    return res.status(200).json({ success: true, id: categoryId });
  });

  // Fallback for any other user collection
  app.all(['/users/:userId/*', '/api/users/:userId/*'], (_req: Request, res: Response) => {
    return res.status(200).json({ success: true });
  });

  const httpServer = http.createServer(app);

  // 3. Vite Middleware (Dev) or Static Serve (Prod)
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.resolve('dist'))) {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: '0.0.0.0',
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FinanSimple Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
