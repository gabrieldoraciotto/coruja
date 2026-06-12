FROM node:20-alpine

WORKDIR /app

# Instalar dependências do backend
COPY package*.json ./
RUN npm install

# Copiar código completo
COPY . .

# Gerar cliente Prisma
RUN npm run db:generate

EXPOSE 3000

CMD ["node", "scripts/wait-and-migrate.js"]
