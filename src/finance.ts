import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Prisma, PaymentMethod } from '@prisma/client';
import { Actor, AuthRequest, Roles } from './auth';
import { audit, dateRange, ListQuery, money, pagination, pageResult, sum, sorting, Transactions } from './common';
import { LedgerDto, PaymentDto } from './dto';
import { orderScope } from './orders';
import { PrismaService } from './prisma.service';

@Injectable()
export class FinanceService {
  constructor(private readonly db: PrismaService, private readonly tx: Transactions) {}
  async payments(q: ListQuery, actor: Actor) {
    const where: Prisma.PaymentWhereInput = { order: orderScope(actor), paidAt: dateRange(q), ...(q.search ? { order: { ...orderScope(actor), customer: { firstName: { contains: q.search, mode: 'insensitive' } } } } : {}) };
    if (q.status) { if (!Object.values(PaymentMethod).includes(q.status as PaymentMethod)) throw new BadRequestException('To?lov usuli noto‘g‘ri'); where.method = q.status as PaymentMethod; }
    const [data, total] = await this.db.$transaction([this.db.payment.findMany({ where, include: { order: { select: { number: true, customer: { select: { firstName: true, lastName: true } } } }, receivedBy: { select: { name: true } } }, ...pagination(q), orderBy: sorting(q, ['amount', 'method', 'paidAt'], 'paidAt') }), this.db.payment.count({ where })]); return pageResult(data, total, q);
  }
  async pay(dto: PaymentDto, actor: Actor) {
    if (money(dto.amount).lte(0)) throw new BadRequestException('To‘lov musbat bo‘lishi kerak');
    if (dto.paidAt && new Date(dto.paidAt).getTime() > Date.now() + 60000) throw new BadRequestException('Kelajak sana mumkin emas');
    return this.tx.run(async tx => {
      const order = await tx.order.findFirstOrThrow({ where: { id: dto.orderId, ...orderScope(actor) }, include: { payments: true, items: true } });
      const existing = await tx.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        if (existing.orderId !== order.id || !existing.amount.eq(dto.amount) || existing.method !== dto.method || existing.receivedById !== actor.id || (existing.note ?? '') !== (dto.note ?? '')) throw new BadRequestException('Takroriy kalit boshqa to‘lov uchun ishlatilgan');
        const record = await tx.auditLog.findFirst({ where: { entityType: 'Payment', entityId: existing.id, action: 'CREATE' }, orderBy: { createdAt: 'desc' } });
        const original = record?.newValue as { itemPrices?: unknown } | null;
        if (JSON.stringify(original?.itemPrices ?? null) !== JSON.stringify(dto.itemPrices ?? null)) throw new BadRequestException('Takroriy kalit boshqa narxlar uchun ishlatilgan');
        return existing;
      }
      if (order.status === 'CANCELLED') throw new BadRequestException('Bekor qilingan buyurtmaga to‘lov mumkin emas');
      const paid = sum(order.payments.map(p => p.amount));
      let total = order.totalAmount;
      const { itemPrices, ...paymentData } = dto;
      if (itemPrices) {
        if (new Set(itemPrices.map(item => item.id)).size !== itemPrices.length || itemPrices.some(item => !order.items.some(original => original.id === item.id))) throw new BadRequestException('Buyurtma mahsulotlari noto‘g‘ri');
        const prices = new Map(itemPrices.map(item => [item.id, money(item.salePrice)]));
        total = sum(order.items.map(item => (prices.get(item.id) ?? item.salePrice).mul(item.quantity)));
        if (total.gt('9999999999999999.99')) throw new BadRequestException('Buyurtma summasi ruxsat etilgan chegaradan katta');
        if (total.lt(paid)) throw new BadRequestException('Yangi narx oldingi to‘lovlardan kam bo‘lishi mumkin emas');
        if (!total.eq(order.totalAmount) || order.items.some(item => prices.has(item.id) && !prices.get(item.id)!.eq(item.salePrice))) {
          for (const item of itemPrices) await tx.orderItem.update({ where: { id: item.id }, data: { salePrice: money(item.salePrice) } });
          await tx.order.update({ where: { id: order.id }, data: { totalAmount: total, companyAmount: total } });
          const difference = total.minus(order.companyAmount);
          if (!difference.eq(0)) await tx.dealerTransaction.create({ data: { dealerId: order.dealerId, orderId: order.id, type: 'ORDER_CHARGE', amount: difference, reason: 'Mahsulot narxi tahrirlandi', reference: `price:${dto.idempotencyKey}`, createdById: actor.id } });
          await audit(tx, actor.id, 'UPDATE', 'Order', order.id, { totalAmount: order.totalAmount, items: order.items }, { totalAmount: total, itemPrices });
        }
      }
      if (paid.plus(dto.amount).gt(total)) throw new BadRequestException('To‘lov qarzdan oshib ketdi');
      const payment = await tx.payment.create({ data: { ...paymentData, receivedById: actor.id, paidAt: dto.paidAt ? new Date(dto.paidAt) : undefined } });
      await tx.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      await tx.dealerTransaction.create({ data: { dealerId: order.dealerId, orderId: order.id, paymentId: payment.id, type: 'PAYMENT', amount: money(dto.amount).neg(), reason: 'Mijoz to‘lovi — kompaniya tushumi', reference: `payment:${payment.id}`, createdById: actor.id } });
      await audit(tx, actor.id, 'CREATE', 'Payment', payment.id, undefined, { ...payment, itemPrices: dto.itemPrices ?? null }); return payment;
    });
  }
  async dealers(q: ListQuery, actor: Actor) {
    const where: Prisma.DealerWhereInput = { ...(actor.role === 'DEALER' ? { id: actor.dealerId ?? '' } : {}), ...(q.search ? { user: { name: { contains: q.search, mode: 'insensitive' } } } : {}) };
    const [rows, total] = await this.db.$transaction([this.db.dealer.findMany({ where, include: { user: { select: { name: true, phone: true, active: true } }, transactions: { select: { amount: true, type: true } } }, ...pagination(q), orderBy: { createdAt: q.direction } }), this.db.dealer.count({ where })]);
    return pageResult(rows.map(({ transactions, ...d }) => ({ ...d, balance: sum(transactions.map(t => t.amount)), charged: sum(transactions.filter(t => t.type === 'ORDER_CHARGE' || t.type === 'CANCELLATION').map(t => t.amount)), paid: sum(transactions.filter(t => t.type === 'PAYMENT').map(t => t.amount)).neg(), margin: '0' })), total, q);
  }
  async dealer(id: string, actor: Actor) {
    if (actor.role === 'DEALER' && actor.dealerId !== id) throw new ForbiddenException();
    const record = await this.db.dealer.findUniqueOrThrow({ where: { id }, include: { user: { select: { name: true, phone: true, active: true } }, transactions: true, orders: { select: { id: true, number: true, status: true, totalAmount: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 20 } } });
    const { transactions, ...rest } = record;
    return { ...rest, balance: sum(transactions.map(t => t.amount)), charged: sum(transactions.filter(t => ['ORDER_CHARGE', 'CANCELLATION'].includes(t.type)).map(t => t.amount)), paid: sum(transactions.filter(t => t.type === 'PAYMENT').map(t => t.amount)).neg(), margin: '0' };
  }
  async ledger(id: string, q: ListQuery, actor: Actor) {
    if (actor.role === 'DEALER' && actor.dealerId !== id) throw new ForbiddenException();
    const where = { dealerId: id, createdAt: dateRange(q) };
    const [data, total] = await this.db.$transaction([this.db.dealerTransaction.findMany({ where, include: { order: { select: { number: true } }, createdBy: { select: { name: true } } }, ...pagination(q), orderBy: sorting(q, ['type', 'amount', 'reason', 'createdAt']) }), this.db.dealerTransaction.count({ where })]); return pageResult(data, total, q);
  }
  async correction(id: string, dto: LedgerDto, actor: Actor) {
    if (money(dto.amount).eq(0)) throw new BadRequestException('Nol tuzatish mumkin emas');
    return this.tx.run(async tx => { const entry = await tx.dealerTransaction.create({ data: { dealerId: id, ...dto, type: 'CORRECTION', createdById: actor.id } }); await audit(tx, actor.id, 'CORRECTION', 'DealerTransaction', entry.id, undefined, entry); return entry; });
  }
}
@Controller()
export class FinanceController {
  constructor(private readonly service: FinanceService) {}
  @Get('payments') @Roles('ADMIN', 'ACCOUNTANT', 'DEALER') payments(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.payments(q, req.user); }
  @Post('payments') @Roles('ADMIN', 'ACCOUNTANT') pay(@Body() dto: PaymentDto, @Req() req: AuthRequest) { return this.service.pay(dto, req.user); }
  @Get('dealers') @Roles('ADMIN', 'ACCOUNTANT', 'DEALER') dealers(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.dealers(q, req.user); }
  @Get('dealers/:id') @Roles('ADMIN', 'ACCOUNTANT', 'DEALER') dealer(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.dealer(id, req.user); }
  @Get('dealers/:id/ledger') @Roles('ADMIN', 'ACCOUNTANT', 'DEALER') ledger(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.ledger(id, q, req.user); }
  @Post('dealers/:id/ledger') @Roles('ADMIN', 'ACCOUNTANT') correction(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LedgerDto, @Req() req: AuthRequest) { return this.service.correction(id, dto, req.user); }
}
