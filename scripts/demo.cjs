const { randomUUID } = require('node:crypto');
const base = 'http://127.0.0.1:3001/api/';
const password = 'DemoKatyol2026!';
let cookie = '';
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json();
  if (!r.ok) throw Error(`${method} ${route}: ${JSON.stringify(data)}`);
  if (route === 'auth/login') cookie = r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return data;
}
async function all(route) {
  const rows = []; let page = 1;
  while (true) { const r = await api(`${route}?page=${page}&limit=100`); rows.push(...r.data); if (rows.length >= r.total || !r.data.length) return rows; page++; }
}
async function main() {
  await api('auth/login', 'POST', { phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD });
  const users = await all('users');
  for (const [i, role, name] of [[1, 'DEALER', 'Diller'], [2, 'WAREHOUSE', 'Omborchi'], [3, 'DELIVERY_INSTALLER', 'Yetkazuvchi'], [4, 'ACCOUNTANT', 'Hisobchi']]) {
    const phone = `+99890077700${i}`;
    if (!users.some(u => u.phone === phone)) users.push(await api('users', 'POST', { name: `Namuna ${name}`, phone, password, role }));
  }
  const dealer = (await all('users')).find(u => u.phone === '+998900777001').dealer;
  if (!dealer) throw Error('Namuna diller hisobi topilmadi');
  const categories = await all('categories');
  const category = categories.find(c => c.name === 'Kotyollar') ?? await api('categories', 'POST', { name: 'Kotyollar' });
  const warehouses = await all('warehouses');
  const warehouse = warehouses.find(w => w.name === 'Namuna ombori') ?? await api('warehouses', 'POST', { name: 'Namuna ombori', address: 'NAMUNA: Toshkent shahri, Chilonzor tumani' });
  const products = await all('products'); const demoProducts = [];
  for (const type of ['AT', 'ATK']) for (const power of type === 'AT' ? [25, 35, 50, 75, 100] : [25, 35, 50]) {
    const model = `NAMUNA-${type}-${power}`;
    const sale = (type === 'AT' ? 4500000 : 6000000) + power * 100000;
    const product = products.find(p => p.model === model) ?? await api('products', 'POST', { name: `Namuna ${type} ${power} kVt katyol`, model, categoryId: category.id, powerKw: power, costPrice: String(Math.round(sale * .7)), dealerPrice: String(sale), salePrice: String(sale), note: 'NAMUNA: narxlar shartli, haqiqiy taklif emas', active: true });
    demoProducts.push(product);
    const stock = (await all('warehouse/stock')).find(s => s.warehouseId === warehouse.id && s.productId === product.id);
    if (!stock) await api('warehouse/stock', 'POST', { warehouseId: warehouse.id, productId: product.id, type: 'IN', quantity: 10, reason: 'NAMUNA: boshlangâ€˜ich ombor qoldigâ€˜i' });
  }
  const customers = await all('customers'); const orders = await all('orders');
  for (const [index, firstName, lastName, region, district] of [[0, 'Aziz', 'Karimov', 'Toshkent', 'Chilonzor'], [1, 'Sardor', 'Aliyev', 'Samarqand', 'Urgut'], [2, 'Dilshod', 'Rahimov', 'Fargâ€˜ona', 'Qoâ€˜qon']]) {
    const phone = `+99890077710${index}`;
    const customer = customers.find(c => c.phone === phone) ?? await api('customers', 'POST', { firstName: `Namuna ${firstName}`, lastName, phone, region, district, address: `NAMUNA: ${region}, ${district}, 1-uy`, dealerId: dealer.id, note: 'NAMUNA: sinov uchun xaridor' });
    const note = `NAMUNA-BUYURTMA-${index + 1}`;
    if (orders.some(o => o.note === note)) continue;
    const product = demoProducts[[0, 5, 2][index]];
    const order = await api('orders', 'POST', { customerId: customer.id, dealerId: dealer.id, warehouseId: warehouse.id, phone, address: customer.address, deliveryPrice: '200000', installationPrice: '300000', discount: '0', controlPanel: ['UZB', 'TURK', 'XITOY'][index], accessories: index === 1 ? ['BUNKER', 'MOTOR', 'BLOWER', 'PASSPORT'] : ['BRUSH', 'POKER', 'ASH_PAN', 'PASSPORT'], note, items: [{ productId: product.id, quantity: 1, salePrice: String(product.salePrice), boilerType: index === 1 ? 'ATK' : 'AT' }] });
    if (index > 0) await api(`orders/${order.id}/status`, 'POST', { status: 'CONFIRMED', note: 'NAMUNA: tasdiqlandi' });
    if (index === 2) {
      await api(`orders/${order.id}/status`, 'POST', { status: 'READY', note: 'NAMUNA: yetkazishga tayyor' });
      await api(`orders/${order.id}/assign`, 'POST', { assignedToId: users.find(u => u.phone === '+998900777003').id, scheduledAt: new Date(Date.now() + 86400000).toISOString(), note: 'NAMUNA: yetkazish topshirigâ€˜i' });
    }
    if (index === 1) await api('payments', 'POST', { orderId: order.id, amount: '2000000', method: 'CASH', idempotencyKey: randomUUID(), note: 'NAMUNA: boshlangâ€˜ich toâ€˜lov' });
  }
  console.log(JSON.stringify({ products: demoProducts.length, warehouse: warehouse.name, sampleAccounts: 4, sampleCustomers: 3, sampleOrders: 3, password }, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

