import { Body, Controller, Get, Injectable, Param, ParseUUIDPipe, Patch, Post, Query, Req, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { Actor, AuthRequest, hashPassword, Roles } from './auth';
import { audit, ListQuery, money, pagination, pageResult, sum, sorting, Transactions } from './common';
import { CategoryDto, CustomerDto, CustomerUpdate, ProductDto, ProductUpdate, UserDto, UserUpdate, WarehouseDto } from './dto';

export const userSelect = { id: true, name: true, phone: true, role: true, active: true, createdAt: true, dealer: true } as const;
export const productSelect = { id: true, name: true, model: true, categoryId: true, powerKw: true, imageUrl: true, note: true, active: true, category: true, createdAt: true } as const;
export function productFields(actor: Actor) { return { ...productSelect, ...(actor.role !== 'WAREHOUSE' && actor.role !== 'DELIVERY_INSTALLER' ? { salePrice: true } : {}) }; }
@Injectable()
export class CatalogService {
  constructor(private readonly db: PrismaService, private readonly tx: Transactions) {}
  async products(q: ListQuery, actor: Actor) {
    const where: Prisma.ProductWhereInput = { ...(q.search ? { OR: ['name', 'model'].map(key => ({ [key]: { contains: q.search, mode: 'insensitive' } })) } : {}), ...(q.status ? { active: q.status === 'active' } : {}) };
    const [data, total] = await this.db.$transaction([this.db.product.findMany({ where, select: productFields(actor), ...pagination(q), orderBy: sorting(q, ['name', 'model', 'powerKw', 'active', 'createdAt', ...(['ADMIN', 'DEALER', 'ACCOUNTANT'].includes(actor.role) ? ['salePrice'] : [])]) }), this.db.product.count({ where })]);
    return pageResult(data, total, q);
  }
  productWrite(dto: ProductDto | ProductUpdate, actor: Actor, id?: string) {
    return this.tx.run(async tx => {
      const old = id ? await tx.product.findUniqueOrThrow({ where: { id } }) : undefined;
      const value = id ? await tx.product.update({ where: { id }, data: { ...dto, dealerPrice: '0' } }) : await tx.product.create({ data: { ...dto as ProductDto, costPrice: dto.costPrice ?? '0', dealerPrice: '0' } });
      await audit(tx, actor.id, id ? 'UPDATE' : 'CREATE', 'Product', value.id, old, value); return value;
    });
  }
  async customers(q: ListQuery, actor: Actor) {
    const where: Prisma.CustomerWhereInput = { ...(actor.role === 'DEALER' ? { dealerId: actor.dealerId ?? '' } : {}), ...(q.search ? { OR: ['firstName', 'lastName', 'phone'].map(key => ({ [key]: { contains: q.search, mode: 'insensitive' } })) } : {}) };
    const [data, total] = await this.db.$transaction([this.db.customer.findMany({ where, ...pagination(q), orderBy: sorting(q, ['firstName', 'lastName', 'phone', 'region', 'district', 'address', 'createdAt']) }), this.db.customer.count({ where })]); return pageResult(data, total, q);
  }
  async customer(id: string, actor: Actor) {
    const customer = await this.db.customer.findFirstOrThrow({ where: { id, ...(actor.role === 'DEALER' ? { dealerId: actor.dealerId ?? '' } : {}) }, include: { orders: { where: actor.role === 'DEALER' ? { dealerId: actor.dealerId ?? '' } : {}, include: { payments: true } } } });
    const activeOrders = customer.orders.filter(o => o.status !== 'CANCELLED');
    const total = sum(activeOrders.map(o => o.totalAmount)); const paid = sum(activeOrders.flatMap(o => o.payments.map(p => p.amount)));
    return { ...customer, total, paid, debt: total.minus(paid) };
  }
  async customerWrite(dto: CustomerDto | CustomerUpdate, actor: Actor, id?: string) {
    return this.tx.run(async tx => {
      const old = id ? await tx.customer.findFirstOrThrow({ where: { id, ...(actor.role === 'DEALER' ? { dealerId: actor.dealerId ?? '' } : {}) } }) : undefined;
      const data = { ...dto, ...(actor.role === 'DEALER' ? { dealerId: actor.dealerId! } : {}) };
      if (id && dto.dealerId && dto.dealerId !== old?.dealerId) throw new BadRequestException('Mijoz egasini o‘zgartirish mumkin emas');
      const value = id ? await tx.customer.update({ where: { id }, data }) : await tx.customer.create({ data: { ...data as CustomerDto, createdById: actor.id } });
      await audit(tx, actor.id, id ? 'UPDATE' : 'CREATE', 'Customer', value.id, old, value); return value;
    });
  }
  async users(q: ListQuery) {
    if (q.status && !Object.values(Role).includes(q.status as Role)) throw new BadRequestException('Rol noto?g?ri');
    const where: Prisma.UserWhereInput = q.search ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { phone: { contains: q.search } }] } : {};
    if (q.status) where.role = q.status as Role;
    const [data, total] = await this.db.$transaction([this.db.user.findMany({ where, select: userSelect, ...pagination(q), orderBy: sorting(q, ['name', 'phone', 'role', 'active', 'createdAt']) }), this.db.user.count({ where })]); return pageResult(data, total, q);
  }
  async userWrite(dto: UserDto | UserUpdate, actor: Actor, id?: string) {
    const { password, ...rest } = dto; const passwordHash = password ? await hashPassword(password) : undefined;
    return this.tx.run(async tx => {
      const old = id ? await tx.user.findUniqueOrThrow({ where: { id }, select: userSelect }) : undefined;
      if (old?.role === 'ADMIN' && old.active && (('active' in rest && rest.active === false) || (rest.role && rest.role !== 'ADMIN'))) {
        if (await tx.user.count({ where: { role: 'ADMIN', active: true } }) <= 1) throw new BadRequestException('Kamida bitta faol administrator qolishi kerak');
      }
      if (id === actor.id && (('active' in rest && rest.active === false) || (rest.role && rest.role !== actor.role))) throw new BadRequestException('O‘zingizning admin huquqingizni olib tashlay olmaysiz');
      if (old?.role === 'DEALER' && rest.role && rest.role !== 'DEALER') throw new BadRequestException('Sotuvchi rolini o‘zgartirish o‘rniga foydalanuvchini faolsizlantiring');
      const value = id ? await tx.user.update({ where: { id }, data: { ...rest, passwordHash }, select: userSelect }) : await tx.user.create({ data: { ...rest as Omit<UserDto, 'password'>, passwordHash: passwordHash! }, select: userSelect });
      if (value.role === 'DEALER') await tx.dealer.upsert({ where: { userId: value.id }, create: { userId: value.id }, update: {} });
      if (id) await tx.refreshSession.updateMany({ where: { userId: id }, data: { revokedAt: new Date() } });
      await audit(tx, actor.id, id ? 'UPDATE' : 'CREATE', 'User', value.id, old, value); return value;
    });
  }
}
@Controller()
export class CatalogController {
  constructor(private readonly service: CatalogService, private readonly db: PrismaService, private readonly tx: Transactions) {}
  @Get('products') @Roles('ADMIN', 'DEALER', 'WAREHOUSE', 'ACCOUNTANT') products(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.products(q, req.user); }
  @Post('products') @Roles('ADMIN') createProduct(@Body() dto: ProductDto, @Req() req: AuthRequest) { return this.service.productWrite(dto, req.user); }
  @Patch('products/:id') @Roles('ADMIN') updateProduct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ProductUpdate, @Req() req: AuthRequest) { return this.service.productWrite(dto, req.user, id); }
  @Get('customers') @Roles('ADMIN', 'DEALER', 'ACCOUNTANT') customers(@Query() q: ListQuery, @Req() req: AuthRequest) { return this.service.customers(q, req.user); }
  @Get('customers/:id') @Roles('ADMIN', 'DEALER', 'ACCOUNTANT') customer(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) { return this.service.customer(id, req.user); }
  @Post('customers') @Roles('ADMIN', 'DEALER') createCustomer(@Body() dto: CustomerDto, @Req() req: AuthRequest) { return this.service.customerWrite(dto, req.user); }
  @Patch('customers/:id') @Roles('ADMIN', 'DEALER') updateCustomer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CustomerUpdate, @Req() req: AuthRequest) { return this.service.customerWrite(dto, req.user, id); }
  @Get('users') @Roles('ADMIN') users(@Query() q: ListQuery) { return this.service.users(q); }
  @Post('users') @Roles('ADMIN') createUser(@Body() dto: UserDto, @Req() req: AuthRequest) { return this.service.userWrite(dto, req.user); }
  @Patch('users/:id') @Roles('ADMIN') updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UserUpdate, @Req() req: AuthRequest) { return this.service.userWrite(dto, req.user, id); }
  @Get('staff') @Roles('ADMIN', 'WAREHOUSE') staff() { return this.db.user.findMany({ where: { active: true, role: { in: ['WAREHOUSE', 'DELIVERY_INSTALLER'] } }, select: { id: true, name: true, role: true } }); }
  @Get('categories') @Roles('ADMIN', 'DEALER', 'WAREHOUSE', 'ACCOUNTANT') async categories(@Query() q: ListQuery) {
    const where = q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {};
    const [data, total] = await this.db.$transaction([this.db.category.findMany({ where, ...pagination(q), orderBy: { name: q.direction } }), this.db.category.count({ where })]); return pageResult(data, total, q);
  }
  @Post('categories') @Roles('ADMIN') category(@Body() dto: CategoryDto, @Req() req: AuthRequest) { return this.tx.run(async tx => { const value = await tx.category.create({ data: dto }); await audit(tx, req.user.id, 'CREATE', 'Category', value.id, undefined, value); return value; }); }
  @Patch('categories/:id') @Roles('ADMIN') categoryUpdate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryDto, @Req() req: AuthRequest) { return this.tx.run(async tx => { const old = await tx.category.findUniqueOrThrow({ where: { id } }); const value = await tx.category.update({ where: { id }, data: dto }); await audit(tx, req.user.id, 'UPDATE', 'Category', id, old, value); return value; }); }
  @Get('warehouses') @Roles('ADMIN', 'WAREHOUSE', 'DEALER', 'ACCOUNTANT') async warehouses(@Query() q: ListQuery) {
    const where = q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {};
    const [data, total] = await this.db.$transaction([this.db.warehouse.findMany({ where, ...pagination(q), orderBy: { name: q.direction } }), this.db.warehouse.count({ where })]); return pageResult(data, total, q);
  }
  @Post('warehouses') @Roles('ADMIN') warehouse(@Body() dto: WarehouseDto, @Req() req: AuthRequest) { return this.tx.run(async tx => { if (await tx.warehouse.count()) throw new BadRequestException('Faqat bitta ombor mavjud bo‘lishi mumkin'); const value = await tx.warehouse.create({ data: dto }); await audit(tx, req.user.id, 'CREATE', 'Warehouse', value.id, undefined, value); return value; }); }
  @Patch('warehouses/:id') @Roles('ADMIN') warehouseUpdate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: WarehouseDto, @Req() req: AuthRequest) { return this.tx.run(async tx => { const old = await tx.warehouse.findUniqueOrThrow({ where: { id } }); const value = await tx.warehouse.update({ where: { id }, data: dto }); await audit(tx, req.user.id, 'UPDATE', 'Warehouse', id, old, value); return value; }); }
}

