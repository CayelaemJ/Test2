FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# copy EVERYTHING first so prisma/schema.prisma is present before any prisma command
COPY . .
RUN npm install
RUN npm run build
CMD npm start
