# Techno Backend

NestJS, Prisma va PostgreSQL asosidagi Techno savdo, ombor va hisob-kitob tizimi API serveri.

## Ishga tushirish

```bash
cp .env.example .env
npm ci
npm run db:generate
npx prisma migrate deploy
npm run admin:create
npm run build
npm start
```

Standart API manzili: `http://localhost:3001/api`. Swagger: `http://localhost:3001/api/docs`.

`.env` ichida `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PHONE`, `ADMIN_PASSWORD` va frontend domenini sozlang. Maxfiy `.env` faylini Git'ga qo‘shmang.

## Docker bilan serverga o‘rnatish

Serverda Docker va Docker Compose o‘rnatilgan bo‘lishi kerak:

```bash
cp .env.example .env
# .env ichidagi barcha parol, JWT_SECRET va FRONTEND_ORIGIN ni almashtiring
export POSTGRES_PASSWORD='juda-kuchli-db-parol'
docker compose up -d --build
```

Container ishga tushganda migratsiyalarni qo‘llaydi va admin mavjud bo‘lmasa
yaratadi. API faqat serverning `127.0.0.1:3001` manziliga ochiladi; uni HTTPS
reverse proxy (Nginx yoki Caddy) ortidan chiqaring. `FRONTEND_ORIGIN` ga haqiqiy
frontend domenini, masalan `https://app.example.uz`, yozing.

Yangilash:

```bash
git pull --ff-only
docker compose up -d --build
```

PostgreSQL ma’lumoti `postgres_data` Docker volume ichida saqlanadi. Serverda
shu volume uchun muntazam backup sozlang.

