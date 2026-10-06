# Documentação da API - Sistema de Gestão Financeira

Esta documentação técnica descreve a arquitetura da API, o modelo de autenticação, o esquema de dados no Cloud Firestore, os endpoints REST diretos (para integrações externas, cURL, Postman e testes de segurança) e os serviços TypeScript do cliente.

---

## 1. Visão Geral & Arquitetura

O sistema utiliza arquitetura orientada a serviços em nuvem com o **Google Cloud Firestore** e **Firebase Authentication**. Toda a persistência é distribuída e protegida por regras granulares no servidor (*Firestore Security Rules*).

* **Plataforma:** Firebase Cloud Firestore & Google Cloud Identity Platform
* **Formato de Dados:** JSON / Firestore Document Format
* **Modo de Autenticação:** Bearer Token JWT (Firebase ID Token via OAuth 2.0 / Google Identity)
* **Padrão de Isolamento:** Separação estrita multi-inquilino baseada no UID autenticado (`/users/{userId}/*`).

---

## 2. Credenciais & Parâmetros de Conexão

| Parâmetro | Valor | Descrição |
| :--- | :--- | :--- |
| **Project ID** | `gen-lang-client-0903542800` | Identificador único do projeto no Google Cloud |
| **Firestore Database ID** | `ai-studio-finansimplecontr-ba028d80-6251-4c94-a32c-9a025f5b4acf` | Instância específica do banco Firestore |
| **Web API Key** | `AIzaSyCZ7U1OvvpGl1fxBv1D4xuSZ_ybZaU7xSw` | Chave de cliente para troca de tokens e chamadas públicas |
| **OAuth Client ID** | `206617273400-soqpk310lrfbb6a37fq5q688mrg5f55e.apps.googleusercontent.com` | Client ID para autenticação Google Identity |
| **App ID** | `1:206617273400:web:bec32866fe388b7e9172cd` | ID da aplicação Web no Firebase |
| **Auth Domain** | `gen-lang-client-0903542800.firebaseapp.com` | Domínio de retorno de autenticação |

---

## 3. Autenticação & Autorização

### 3.1. Obtenção do Token JWT (Firebase ID Token)

Para requisições externas via HTTP REST, é obrigatório incluir o cabeçalho `Authorization`:

```http
Authorization: Bearer <FIREBASE_ID_TOKEN>
```

#### Como obter o ID Token para testes:
1. **Pela aplicação Web:**
   No console do desenvolvedor do navegador (F12):
   ```javascript
   const token = await window.firebaseAuth.currentUser.getIdToken();
   console.log(token);
   ```
2. **Via Google Identity Toolkit REST API:**
   ```bash
   POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaSyCZ7U1OvvpGl1fxBv1D4xuSZ_ybZaU7xSw
   Content-Type: application/json

   {
     "email": "usuario@exemplo.com",
     "password": "senhaDoUsuario",
     "returnSecureToken": true
   }
   ```
   A resposta conterá `idToken` (válido por 1 hora) e `localId` (o `userId`).

---

## 4. Endpoints REST do Cloud Firestore

### 4.1. URL Base dos Recursos

A URL base para acessar documentos diretamente na instância dedicada do banco é:

```
https://firestore.googleapis.com/v1/projects/gen-lang-client-0903542800/databases/ai-studio-finansimplecontr-ba028d80-6251-4c94-a32c-9a025f5b4acf/documents
```

> **Atenção:** Todas as rotas de dados requerem o prefixo do usuário autenticado: `/users/{userId}/...`

---

### 4.2. Módulo de Transações (`/transactions`)

#### 4.2.1. Listar Transações do Usuário
* **Método:** `GET`
* **Rota:** `/users/{userId}/transactions`
* **Exemplo cURL:**
  ```bash
  curl -X GET "https://firestore.googleapis.com/v1/projects/gen-lang-client-0903542800/databases/ai-studio-finansimplecontr-ba028d80-6251-4c94-a32c-9a025f5b4acf/documents/users/{userId}/transactions" \
    -H "Authorization: Bearer <ID_TOKEN>"
  ```

#### 4.2.2. Criar ou Atualizar Transação
* **Método:** `PATCH`
* **Rota:** `/users/{userId}/transactions/{transactionId}`
* **Headers:** `Content-Type: application/json`, `Authorization: Bearer <ID_TOKEN>`
* **Payload Firestore REST:**
  ```json
  {
    "fields": {
      "id": { "stringValue": "tx-12345" },
      "description": { "stringValue": "Supermercado Semanal" },
      "amount": { "doubleValue": 250.75 },
      "type": { "stringValue": "despesa" },
      "categoryId": { "stringValue": "cat-alimentacao" },
      "date": { "stringValue": "2026-10-02" },
      "status": { "stringValue": "pago" },
      "sourceType": { "stringValue": "cartao" },
      "creditCardId": { "stringValue": "card-1" },
      "notes": { "stringValue": "Compra no cartão de crédito" },
      "userId": { "stringValue": "{userId}" },
      "createdAt": { "stringValue": "2026-10-02T12:00:00.000Z" },
      "isInstallment": { "booleanValue": false }
    }
  }
  ```

#### 4.2.3. Excluir Transação
* **Método:** `DELETE`
* **Rota:** `/users/{userId}/transactions/{transactionId}`
* **Exemplo cURL:**
  ```bash
  curl -X DELETE "https://firestore.googleapis.com/v1/projects/gen-lang-client-0903542800/databases/ai-studio-finansimplecontr-ba028d80-6251-4c94-a32c-9a025f5b4acf/documents/users/{userId}/transactions/{transactionId}" \
    -H "Authorization: Bearer <ID_TOKEN>"
  ```

---

### 4.3. Módulo de Contas Bancárias (`/accounts`)

#### 4.3.1. Listar Contas
* **Método:** `GET`
* **Rota:** `/users/{userId}/accounts`

#### 4.3.2. Criar / Atualizar Conta
* **Método:** `PATCH`
* **Rota:** `/users/{userId}/accounts/{accountId}`
* **Payload:**
  ```json
  {
    "fields": {
      "id": { "stringValue": "acc-corrente-01" },
      "name": { "stringValue": "Banco Inter" },
      "type": { "stringValue": "corrente" },
      "initialBalance": { "doubleValue": 1500.00 },
      "color": { "stringValue": "#ea580c" },
      "isDefault": { "booleanValue": true },
      "userId": { "stringValue": "{userId}" }
    }
  }
  ```

#### 4.3.3. Excluir Conta
* **Método:** `DELETE`
* **Rota:** `/users/{userId}/accounts/{accountId}`

---

### 4.4. Módulo de Cartões de Crédito (`/creditCards`)

#### 4.4.1. Listar Cartões
* **Método:** `GET`
* **Rota:** `/users/{userId}/creditCards`

#### 4.4.2. Criar / Atualizar Cartão
* **Método:** `PATCH`
* **Rota:** `/users/{userId}/creditCards/{cardId}`
* **Payload:**
  ```json
  {
    "fields": {
      "id": { "stringValue": "card-black-01" },
      "name": { "stringValue": "Cartão Master Black" },
      "limit": { "doubleValue": 10000.00 },
      "closingDay": { "integerValue": "25" },
      "dueDay": { "integerValue": "5" },
      "brand": { "stringValue": "mastercard" },
      "color": { "stringValue": "#0f172a" },
      "userId": { "stringValue": "{userId}" }
    }
  }
  ```

#### 4.4.3. Excluir Cartão
* **Método:** `DELETE`
* **Rota:** `/users/{userId}/creditCards/{cardId}`

---

### 4.5. Módulo de Categorias (`/categories`)

#### 4.5.1. Listar Categorias
* **Método:** `GET`
* **Rota:** `/users/{userId}/categories`

#### 4.5.2. Criar / Atualizar Categoria
* **Método:** `PATCH`
* **Rota:** `/users/{userId}/categories/{categoryId}`
* **Payload:**
  ```json
  {
    "fields": {
      "id": { "stringValue": "cat-investimentos" },
      "name": { "stringValue": "Investimentos & Reserva" },
      "type": { "stringValue": "despesa" },
      "color": { "stringValue": "#10b981" },
      "isDefault": { "booleanValue": false },
      "userId": { "stringValue": "{userId}" }
    }
  }
  ```

---

## 5. Esquema dos Modelos de Dados (Types)

### 5.1. Transação (`Transaction`)
```typescript
interface Transaction {
  id: string;                      // Identificador UUID ou timestamp
  description: string;             // Título/descrição da transação
  amount: number;                  // Valor monetário positivo (> 0)
  type: 'receita' | 'despesa';     // Tipo da transação
  categoryId: string;              // ID da categoria correspondente
  date: string;                    // Formato ISO: YYYY-MM-DD
  status?: 'pago' | 'pendente';    // Status da liquidação
  sourceType?: 'conta' | 'cartao'; // Origem do pagamento
  accountId?: string;              // Obrigatório se sourceType === 'conta'
  creditCardId?: string;           // Obrigatório se sourceType === 'cartao'
  notes?: string;                  // Observações opcionais
  createdAt: string;               // ISO 8601 Timestamp
  userId: string;                  // UID do proprietário

  // Parcelamento (opcional)
  isInstallment?: boolean;
  installmentCurrent?: number;     // Ex: 1
  installmentTotal?: number;       // Ex: 10
  installmentGroupId?: string;     // Hash do grupo de parcelas
  installmentTotalAmount?: number; // Valor original total

  // Recorrência (opcional)
  isRecurring?: boolean;
  recurrenceFrequency?: 'mensal' | 'semanal' | 'quinzenal' | 'anual';
  recurrenceCurrent?: number;
  recurrenceCount?: number;
  recurrenceGroupId?: string;
}
```

### 5.2. Conta Bancária (`Account`)
```typescript
interface Account {
  id: string;
  name: string;
  type: 'corrente' | 'poupanca' | 'carteira' | 'investimento' | 'outros';
  initialBalance: number;
  color?: string;                  // Hex: "#0f172a"
  isDefault?: boolean;
  userId: string;
}
```

### 5.3. Cartão de Crédito (`CreditCard`)
```typescript
interface CreditCard {
  id: string;
  name: string;
  limit: number;
  closingDay: number;              // Dia de fechamento: 1 a 31
  dueDay: number;                  // Dia de vencimento: 1 a 31
  brand?: string;                  // Bandeira (ex: 'visa', 'mastercard')
  color?: string;                  // Cor do cartão
  userId: string;
}
```

### 5.4. Categoria (`Category`)
```typescript
interface Category {
  id: string;
  name: string;
  type: 'receita' | 'despesa';
  color?: string;
  isDefault?: boolean;
  userId: string;
}
```

---

## 6. Camada de Serviço TypeScript (`firestoreService`)

A aplicação disponibiliza um serviço unificado em `src/lib/firestoreService.ts` com métodos fortemente tipados:

| Método | Assinatura | Descrição |
| :--- | :--- | :--- |
| `subscribeToUserData` | `(userId: string, subs: UserDataSubscriptions) => () => void` | Inicia listeners WebSockets em tempo real para contas, cartões, categorias e transações. |
| `saveTransaction` | `(userId: string, tx: Transaction) => Promise<void>` | Cria ou atualiza uma transação com merge automático. |
| `batchSaveTransactions` | `(userId: string, txs: Transaction[]) => Promise<void>` | Gravação atômica em lote (utilizada para compras parceladas e repetições). |
| `deleteTransaction` | `(userId: string, txId: string) => Promise<void>` | Remove um documento de transação. |
| `batchDeleteTransactions`| `(userId: string, txIds: string[]) => Promise<void>` | Exclusão atômica de todas as parcelas de um grupo. |
| `saveAccount` | `(userId: string, acc: Account) => Promise<void>` | Cria/atualiza conta bancária. |
| `deleteAccount` | `(userId: string, accId: string) => Promise<void>` | Remove conta bancária. |
| `saveCreditCard` | `(userId: string, card: CreditCard) => Promise<void>` | Cria/atualiza cartão de crédito. |
| `deleteCreditCard` | `(userId: string, cardId: string) => Promise<void>` | Remove cartão de crédito. |
| `saveCategory` | `(userId: string, cat: Category) => Promise<void>` | Cria/atualiza categoria. |
| `deleteCategory` | `(userId: string, catId: string) => Promise<void>` | Remove categoria. |
| `importFullData` | `(userId: string, data: FullBackup) => Promise<void>` | Restauração/importação completa via batch write. |
| `clearAndResetUserData` | `(userId: string, cleanData: CleanData) => Promise<void>` | Limpa todas as coleções do usuário e reimplanta sementes padrão. |

---

## 7. Regras de Segurança & Políticas de Acesso

As regras ativas no Firestore (`firestore.rules`) garantem:

1. **Autenticação Obrigatória:** Nenhuma operação é permitida sem autenticação (`request.auth != null`).
2. **Isolamento Estrito (Multi-Tenant):** O usuário só pode ler, gravar ou excluir sob o seu próprio UID (`request.auth.uid == userId`).
3. **Consistência de Identidade:** Em operações de escrita, se o atributo `userId` for enviado no corpo do documento, ele obrigatoriamente deve ser idêntico ao `request.auth.uid`.
4. **Bloqueio Global Padrão:** Todas as rotas não mapeadas fora de `/users/{userId}/*` são rejeitadas por padrão (`allow read, write: if false;`).

---

## 8. Tratamento de Erros e Códigos HTTP

| Código HTTP | Causa Provável | Ação Recomendada |
| :--- | :--- | :--- |
| `401 Unauthorized` | Token JWT expirado ou ausente no header | Renovar o Firebase ID Token. |
| `403 Forbidden` | Tentativa de acessar `/users/{outroUserId}` | Verificar se o token pertence ao `userId` solicitado no caminho. |
| `404 Not Found` | Documento ou URL base incorreta | Verificar se o databaseId foi fornecido na URL REST. |
| `400 Bad Request` | Formato do Firestore Document JSON inválido | Garantir tipos estritos (`stringValue`, `doubleValue`, `booleanValue`). |
