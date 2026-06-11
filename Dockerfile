FROM node:20-alpine

WORKDIR /app

# Instalar dependências do backend
COPY package*.json ./
RUN npm install

# Copiar código completo
COPY . .

# Gerar cliente Prisma
RUN npm run db:generate

# Build frontend
WORKDIR /app/frontend
RUN npm install && npm run build

# Voltar ao diretório raiz
WORKDIR /app

EXPOSE 3000

CMD ["node", "scripts/wait-and-migrate.js"]
