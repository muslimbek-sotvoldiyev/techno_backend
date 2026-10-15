import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { Actor, AuthRequest, Roles } from './auth';
import { audit, dateRange, ListQuery, money, pagination, pageResult, sum, sorting, Transactions, singleWarehouse } from './common';
import { OrderDto, StatusDto } from './dto';
import { NotificationService } from './notifications';
import { PrismaService } from './prisma.service';

export function orderScope(actor: Actor): Prisma.OrderWhereInput {
  if (actor.role === 'DEALER') return { dealerId: actor.dealerId ?? '00000000-0000-0000-0000-000000000000' };
  if (actor.role === 'DELIVERY_INSTALLER') return { delivery: { assignedToId: actor.id } };
  return {};
}
const orderInclude = { customer: true, dealer: { include: { user: { select: { name: true, phone: true } } } }, warehouse: true, items: true, payments: true, production: { include: { assignedTo: { select: { name: true } } } }, statusHistory: { include: { changedBy: { select: { name: true } } }, orderBy: { createdAt: 'asc' as const } } } satisfies Prisma.OrderInclude;
type FullOrder = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;
function view(order: FullOrder, actor: Actor) {
  const paid = sum(order.payments.map(p => p.amount));
  const result = { ...order, code: `ORD-${String(order.number).padStart(6, '0')}`, paid, debt: order.totalAmount.minus(paid), items: order.items.map(item => { const { costPrice, dealerPrice, ...rest } = item; return rest; }) };
  if (actor.role === 'WAREHOUSE') {
    const { payments, totalAmount, companyAmount, deliveryPrice, installationPrice, discount, paid, debt, ...rest } = result;
    return { ...rest, items: rest.items.map(item => { const { salePrice, ...visible } = item; return visible; }) };
  }
  return result;
}
export const transitions: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['PREPARING', 'CANCELLED'], CONFIRMED: ['PREPARING', 'CANCELLED'], PREPARING: ['READY', 'CANCELLED'],
  READY: [], ASSIGNED: [], DELIVERING: [], DELIVERED: [], INSTALLING: [], COMPLETED: [], CANCELLED: [],
};
@Injectable()
export class OrdersService {
  constructor(private readonly db: PrismaService, private readonly tx: Transactions, private readonly notifications: NotificationService) {}
  async list(q: ListQuery, actor: Actor, forced?: OrderStatus[]) {
    if (q.status && !Object.values(OrderStatus).includes(q.status as OrderStatus)) throw new BadRequestException('Status noto‘g‘ri');
    const where: Prisma.OrderWhereInput = { ...orderScope(actor), ...(forced ? { status: { in: forced } } : {}), ...(q.status ? { status: q.status as OrderStatus } : {}), createdAt: dateRange(q), ...(q.search ? { OR: [{ customer: { firstName: { contains: q.search, mode: 'insensitive' } } }, { customer: { phone: { contains: q.search } } }, ...(Number(q.search.replace('ORD-', '')) ? [{ number: Number(q.search.replace('ORD-', '')) }] : [])] } : {}) };
    const [data, total] = await this.db.$transaction([this.db.order.findMany({ where, include: orderInclude, ...pagination(q), orderBy: sorting(q, ['number', 'status', 'createdAt', ...(actor.role !== 'WAREHOUSE' ? ['totalAmount'] : [])]) }), this.db.order.count({ where })]); return pageResult(data.map(o => view(o, actor)), total, q);
  }
  async get(id: string, actor: Actor) { return view(await this.db.order.findFirstOrThrow({ where: { id, ...orderScope(actor) }, include: orderInclude }), actor); }
  async create(dto: OrderDto, actor: Actor) {
    return this.tx.run(async tx => {
      await tx.user.findFirstOrThrow({ where: { id: actor.id, active: true, role: { in: ['ADMIN', 'DEALER'] } } });
      const seller = await tx.dealer.upsert({ where: { userId: actor.id }, create: { userId: actor.id }, update: {} });
      const dealerId = seller.id;
      if (!dto.customerId && !dto.customer) throw new BadRequestException('Mijoz ma’lumotlarini kiriting');
      if (dto.customerId && dto.customer) throw new BadRequestException('Faqat bitta mijozni kiriting');
      const customer = dto.customerId ? await tx.customer.findUniqueOrThrow({ where: { id: dto.customerId } }) : await tx.customer.create({ data: { ...dto.customer!, dealerId, createdById: actor.id } });
      if (!dto.customerId) await audit(tx, actor.id, 'CREATE', 'Customer', customer.id, undefined, customer);
      if (actor.role === 'DEALER' && customer.dealerId !== dealerId) throw new ForbiddenException('Mijoz sizga tegishli emas');
      const warehouseId = await singleWarehouse(tx, dto.warehouseId);
      if (new Set(dto.items.map(i => i.productId)).size !== dto.items.length) throw new BadRequestException('Bir mahsulotni bir marta kiriting');
      const items = [];
      for (const item of dto.items) {
        const product = await tx.product.findFirstOrThrow({ where: { id: item.productId, active: true } });
        if (item.boilerType && !(item.boilerType === 'AT' ? [25, 35, 50, 75, 100] : [25, 35, 50]).includes(product.powerKw)) throw new BadRequestException('Katyol turi uchun quvvat mos emas');
        items.push({ ...item, powerKw: product.powerKw, salePrice: money(item.salePrice), productName: product.name, model: product.model, costPrice: product.costPrice, dealerPrice: product.dealerPrice });
      }
      const total = sum(items.map(i => i.salePrice.mul(i.quantity)));
      if (total.gt('9999999999999999.99')) throw new BadRequestException('Buyurtma summasi ruxsat etilgan chegaradan katta');
      const deposit = money(dto.deposit ?? '0');
      if (deposit.gt(total)) throw new BadRequestException('Zaklad jami summadan oshmasligi kerak');
      if (deposit.gt(0) && actor.role !== 'ADMIN') throw new ForbiddenException('Zakladni administrator qabul qiladi');
      const { items: _, customer: _customer, orderDate, deposit: _deposit, ...data } = dto;
      const order = await tx.order.create({ data: { ...data, warehouseId, customerId: customer.id, ...(orderDate ? { createdAt: new Date(orderDate) } : {}), dealerId, createdById: actor.id, totalAmount: total, companyAmount: total, items: { create: items }, statusHistory: { create: { toStatus: 'NEW', changedById: actor.id } } } });
      await tx.dealerTransaction.create({ data: { dealerId, orderId: order.id, type: 'ORDER_CHARGE', amount: total, reason: 'Buyurtmaning to‘liq summasi', reference: `order:${order.id}`, createdById: actor.id } });
      if (deposit.gt(0)) {
        const payment = await tx.payment.create({ data: { orderId: order.id, amount: deposit, method: 'CASH', receivedById: actor.id, note: 'Buyurtma zakladi', idempotencyKey: `deposit:${order.id}` } });
        await tx.dealerTransaction.create({ data: { dealerId, orderId: order.id, paymentId: payment.id, type: 'PAYMENT', amount: deposit.neg(), reason: 'Buyurtma zakladi', reference: `payment:${payment.id}`, createdById: actor.id } });
        await audit(tx, actor.id, 'CREATE', 'Payment', payment.id, undefined, payment);
      }
      await audit(tx, actor.id, 'CREATE', 'Order', order.id, undefined, order);
      await this.notifications.role(tx, 'WAREHOUSE', 'ORDER_NEW', 'Yangi buyurtma kelib tushdi', order.id); return order;
    });
  }
  async change(id: string, dto: StatusDto, actor: Actor) {
    return this.tx.run(async tx => {
      const order = await tx.order.findFirstOrThrow({ where: { id, ...orderScope(actor) }, include: { items: true, payments: true, dealer: true } });
      const next = dto.status;
      if (!transitions[order.status].includes(next)) throw new BadRequestException('Bu status o‘tishiga ruxsat yo‘q');
      const warehouseStages = ['CONFIRMED', 'PREPARING', 'READY', 'CANCELLED'];
      if (actor.role !== 'ADMIN') {
        if (order.status === 'COMPLETED') throw new ForbiddenException('Yakunlangan buyurtmani faqat administrator o‘zgartiradi');
        if (actor.role === 'DEALER' && !(next === 'CANCELLED' && order.status === 'NEW')) throw new ForbiddenException();
        if (actor.role === 'WAREHOUSE' && !warehouseStages.includes(next)) throw new ForbiddenException();
        if (actor.role === 'DELIVERY_INSTALLER' && !['DELIVERING', 'DELIVERED', 'INSTALLING', 'COMPLETED'].includes(next)) throw new ForbiddenException();
        if (actor.role === 'ACCOUNTANT') throw new ForbiddenException();
      }
      if (next === 'CANCELLED') {
        if (!dto.cancellationReason?.trim() || !dto.note?.trim()) throw new BadRequestException('Bekor qilish sababi va izoh majburiy');
        if (order.payments.length) throw new BadRequestException('To‘lovli buyurtmani bekor qilish uchun avval refund jarayoni kerak');
        await tx.production.updateMany({ where: { orderId: id }, data: { status: 'CANCELLED' } });
        await tx.dealerTransaction.create({ data: { dealerId: order.dealerId, orderId: id, type: 'CANCELLATION', amount: order.companyAmount.neg(), reason: dto.cancellationReason, reference: `cancel:${id}`, createdById: actor.id } });
      }
      if (next === 'PREPARING') {
        await tx.production.create({ data: { orderId: id, assignedToId: actor.id, status: 'IN_PROGRESS', startedAt: new Date(), note: dto.note } });
      }
      if (next === 'READY') {
        await tx.production.updateMany({ where: { orderId: id }, data: { status: 'FINISHED', finishedAt: new Date() } });
        await this.notifications.send(tx, [order.dealer.userId], 'ORDER_READY', 'Buyurtmangiz tayyor', id);
      }
      const updated = await tx.order.update({ where: { id }, data: { status: next, version: { increment: 1 }, ...(next === 'CANCELLED' ? { cancellationReason: dto.cancellationReason, cancellationNote: dto.note } : {}) } });
      await tx.orderStatusHistory.create({ data: { orderId: id, fromStatus: order.status, toStatus: next, changedById: actor.id, note: dto.note } });
      await audit(tx, actor.id, 'STATUS', 'Order', id, { status: order.status }, { status: next, note: dto.note }); return { id: updated.id, status: updated.status };
    });
  }
}
@Controller()
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @Get('orders') list(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.list(q, req.user); }
  @Get('orders/:id') detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.get(id, req.user); }
  @Post('orders') @Roles('ADMIN', 'DEALER') create(@Body() dto: OrderDto, @Req() req: AuthRequest) { return this.service.create(dto, req.user); }
  @Post('orders/:id/status') @Roles('ADMIN', 'DEALER', 'WAREHOUSE') status(@Param('id', ParseUUIDPipe) id: string, @Body() dto: StatusDto, @Req() req: AuthRequest) { return this.service.change(id, dto, req.user); }
  @Get('production') @Roles('ADMIN', 'WAREHOUSE') production(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.list(q, req.user, ['NEW', 'CONFIRMED', 'PREPARING', 'READY']); }
}
