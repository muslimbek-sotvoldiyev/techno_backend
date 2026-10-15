import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min, MaxLength, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';

export async function singleWarehouse(tx: Prisma.TransactionClient, requestedId?: string) {
  const warehouses = await tx.warehouse.findMany({ where: { active: true }, take: 2, orderBy: { id: 'asc' } });
  if (warehouses.length > 1) throw new BadRequestException('Tizimda faqat bitta faol ombor bo‘lishi kerak');
  const warehouse = warehouses[0] ?? await tx.warehouse.upsert({ where: { name: 'Asosiy ombor' }, create: { name: 'Asosiy ombor', address: 'Asosiy ombor' }, update: { active: true } });
  if (requestedId && requestedId !== warehouse.id) throw new BadRequestException('Ombor noto‘g‘ri');
  return warehouse.id;
}

export class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(40) sort?: string;
  @IsOptional() @IsEnum({ asc: 'asc', desc: 'desc' }) direction: 'asc' | 'desc' = 'desc';
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
export const money = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value);
export const sum = (values: Prisma.Decimal[]) => values.reduce((a, b) => a.plus(b), money(0));
export function dateRange(q: ListQuery) {
  if (q.from && q.to && new Date(q.from) > new Date(q.to)) throw new BadRequestException('Sana oralig‘i noto‘g‘ri');
  const start = (value: string) => new Date(value.length === 10 ? `${value}T00:00:00+05:00` : value);
  return { ...(q.from ? { gte: start(q.from) } : {}), ...(q.to ? { lt: q.to.length === 10 ? new Date(start(q.to).getTime() + 86400000) : start(q.to) } : {}) };
}
export function sorting(q: ListQuery, fields: string[], fallback = 'createdAt') { return { [q.sort && fields.includes(q.sort) ? q.sort : fallback]: q.direction }; }
export function pagination(q: ListQuery) { return { skip: (q.page - 1) * q.limit, take: q.limit }; }
export function pageResult<T>(data: T[], total: number, q: ListQuery) { return { data, total, page: q.page, limit: q.limit, pages: Math.ceil(total / q.limit) }; }

@Injectable()
export class Transactions {
  constructor(private readonly db: PrismaService) {}
  async run<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.db.$transaction(work, { isolationLevel: 'Serializable', timeout: 15000 }); }
      catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1))); continue;
        }
        throw error;
      }
    }
  }
}
export async function audit(tx: Prisma.TransactionClient, userId: string, action: string, entityType: string, entityId: string, oldValue?: unknown, newValue?: unknown) {
  const json = (v: unknown) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  await tx.auditLog.create({ data: { userId, action, entityType, entityId, oldValue: json(oldValue), newValue: json(newValue) } });
}

@Catch()
export class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    let status = 500; let message: unknown = 'Ichki server xatosi';
    if (error instanceof HttpException) { status = error.getStatus(); const body = error.getResponse(); message = typeof body === 'string' ? body : (body as { message?: unknown }).message; }
    else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const errors: Record<string, [number, string]> = { P2002: [409, 'Bu qiymat allaqachon mavjud'], P2003: [400, 'Bog‘langan yozuv noto‘g‘ri'], P2025: [404, 'Yozuv topilmadi'], P2034: [409, 'Parallel o‘zgarish: qayta urinib ko‘ring'], P2004: [400, 'Ma’lumot biznes qoidalariga mos emas'] };
      [status, message] = errors[error.code] ?? [500, 'Ma’lumotlar bazasi xatosi'];
    }
    if (status === 500) console.error(error);
    response.status(status).json({ statusCode: status, message, timestamp: new Date().toISOString() });
  }
}
