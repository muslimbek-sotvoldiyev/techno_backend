import { Controller, Get, Injectable, Query, Req } from '@nestjs/common';
import { Actor, AuthRequest, Roles } from './auth';
import { dateRange, ListQuery, money, pagination, pageResult, sorting, sum } from './common';
import { orderScope } from './orders';
import { PrismaService } from './prisma.service';
import { productSelect } from './catalog';

@Injectable()
export class ReportsService {
  constructor(private readonly db: PrismaService) {}
  async dashboard(actor: Actor) {
    const today = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' }) + 'T00:00:00+05:00');
    const scope = orderScope(actor);
    const statuses = await this.db.order.groupBy({ by: ['status'], where: scope, _count: true });
    const todayOrders = await this.db.order.count({ where: { ...scope, createdAt: { gte: today } } });
    const recent = await this.db.order.findMany({ where: scope, select: { id: true, number: true, status: true, createdAt: true, customer: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' }, take: 6 });
    if (actor.role === 'WAREHOUSE' || actor.role === 'DELIVERY_INSTALLER') return { todayOrders, statuses, recent };
    const [orders, payments] = await Promise.all([
      this.db.order.findMany({ where: { ...scope, status: { not: 'CANCELLED' } }, select: { totalAmount: true, createdAt: true, payments: { select: { amount: true } } } }),
      this.db.payment.aggregate({ where: { order: scope, paidAt: { gte: today } }, _sum: { amount: true } }),
    ]);
    return { todayOrders, statuses, recent, todaySales: sum(orders.filter(o => o.createdAt >= today).map(o => o.totalAmount)), todayRevenue: payments._sum.amount ?? money(0), debt: sum(orders.map(o => o.totalAmount.minus(sum(o.payments.map(p => p.amount))))) };
  }
  async report(q: ListQuery) {
    const range = dateRange(q);
    const [orders, payments] = await this.db.$transaction([
      this.db.order.findMany({ where: { status: { not: 'CANCELLED' }, createdAt: range }, include: { items: true, payments: true, dealer: { include: { user: { select: { name: true } } } } } }),
      this.db.payment.findMany({ where: { paidAt: range } }),
    ]);
    const sales = sum(orders.map(o => o.totalAmount)); const cost = sum(orders.flatMap(o => o.items.map(i => i.costPrice.mul(i.quantity))));
    const productMap = new Map<string, { name: string; quantity: number; sales: ReturnType<typeof money> }>();
    const dealerMap = new Map<string, { name: string; orders: number; sales: ReturnType<typeof money>; paid: ReturnType<typeof money> }>();
    for (const order of orders) {
      const dealer = dealerMap.get(order.dealerId) ?? { name: order.dealer.user.name, orders: 0, sales: money(0), paid: money(0) };
      dealer.orders++; dealer.sales = dealer.sales.plus(order.totalAmount); dealer.paid = dealer.paid.plus(sum(order.payments.map(p => p.amount))); dealerMap.set(order.dealerId, dealer);
      for (const item of order.items) { const product = productMap.get(item.productId) ?? { name: item.productName, quantity: 0, sales: money(0) }; product.quantity += item.quantity; product.sales = product.sales.plus(item.salePrice.mul(item.quantity)); productMap.set(item.productId, product); }
    }
    return { sales, cost, revenue: sum(payments.map(p => p.amount)), debt: sum(orders.map(o => o.totalAmount.minus(sum(o.payments.map(p => p.amount))))), profit: sales.minus(cost), orderCount: orders.length, products: [...productMap.values()], dealers: [...dealerMap.values()], methods: ['CASH', 'CARD', 'TRANSFER', 'OTHER'].map(method => ({ method, amount: sum(payments.filter(p => p.method === method).map(p => p.amount)) })) };
  }
}
@Controller()
export class ReportsController {
  constructor(private readonly service: ReportsService, private readonly db: PrismaService) {}
  @Get('dashboard') dashboard(@Req() req: AuthRequest) { return this.service.dashboard(req.user); }
  @Get('reports') @Roles('ADMIN', 'ACCOUNTANT') report(@Query() q: ListQuery) { return this.service.report(q); }
  @Get('audit') @Roles('ADMIN') async audit(@Query() q: ListQuery) {
    const where = q.search ? { entityType: { contains: q.search, mode: 'insensitive' as const } } : {};
    const [data, total] = await this.db.$transaction([this.db.auditLog.findMany({ where, include: { user: { select: { name: true } } }, ...pagination(q), orderBy: sorting(q, ['action', 'entityType', 'createdAt']) }), this.db.auditLog.count({ where })]); return pageResult(data, total, q);
  }
}
