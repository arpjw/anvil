// Fake in-memory database layer

import type { User, Product, Order, UserId, ProductId, OrderId, PaginatedResult } from './types.js';
import { AppError } from './types.js';

// ---- In-memory stores ----
const users = new Map<UserId, User>();
const products = new Map<ProductId, Product>();
const orders = new Map<OrderId, Order>();

// ---- User CRUD ----

export function createUser(data: Omit<User, 'id' | 'createdAt'>): User {
  const user: User = {
    ...data,
    id: `u_${Date.now()}`,
    createdAt: new Date(),
  };
  users.set(user.id, user);
  return user;
}

export function getUserById(id: UserId): User {
  const user = users.get(id);
  if (!user) throw new AppError(`User ${id} not found`, 'USER_NOT_FOUND', 404);
  return user;
}

export function getUserByEmail(email: string): User | undefined {
  return [...users.values()].find(u => u.email === email);
}

export function listUsers(page = 1, pageSize = 20): PaginatedResult<User> {
  const all = [...users.values()];
  const start = (page - 1) * pageSize;
  return { items: all.slice(start, start + pageSize), total: all.size, page, pageSize };
}

// ---- Product CRUD ----

export function createProduct(data: Omit<Product, 'id'>): Product {
  const product: Product = { ...data, id: `p_${Date.now()}` };
  products.set(product.id, product);
  return product;
}

export function getProductById(id: ProductId): Product {
  const product = products.get(id);
  if (!product) throw new AppError(`Product ${id} not found`, 'PRODUCT_NOT_FOUND', 404);
  return product;
}

export function decrementStock(id: ProductId, qty: number): void {
  const product = getProductById(id);
  if (product.stock < qty) throw new AppError('Insufficient stock', 'OUT_OF_STOCK');
  products.set(id, { ...product, stock: product.stock - qty });
}

// ---- Order CRUD ----

export function createOrder(order: Omit<Order, 'id'>): Order {
  const saved: Order = { ...order, id: `o_${Date.now()}` };
  orders.set(saved.id, saved);
  return saved;
}

export function getOrderById(id: OrderId): Order {
  const order = orders.get(id);
  if (!order) throw new AppError(`Order ${id} not found`, 'ORDER_NOT_FOUND', 404);
  return order;
}

export function updateOrderStatus(id: OrderId, status: Order['status']): Order {
  const order = getOrderById(id);
  const updated = { ...order, status };
  orders.set(id, updated);
  return updated;
}

export function getOrdersByUser(userId: UserId): Order[] {
  return [...orders.values()].filter(o => o.userId === userId);
}
