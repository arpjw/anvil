// Order processing — places orders, validates stock, computes totals

import type { Order, OrderItem } from './types.js';
import { AppError } from './types.js';
import { getProductById, decrementStock, createOrder, getOrderById, updateOrderStatus, getOrdersByUser } from './db.js';
import { getSessionUser } from './auth.js';

function computeTotal(items: OrderItem[]): number {
  return items.reduce((sum, item) => sum + item.unitPriceInCents * item.quantity, 0);
}

function validateItems(items: OrderItem[]): void {
  if (items.length === 0) throw new AppError('Order must have at least one item', 'ORDER_EMPTY');
  for (const item of items) {
    if (item.quantity <= 0) throw new AppError('Item quantity must be positive', 'ORDER_INVALID');
    getProductById(item.productId); // throws if not found
  }
}

export function placeOrder(token: string, rawItems: Omit<OrderItem, 'unitPriceInCents'>[]): Order {
  const user = getSessionUser(token);

  const items: OrderItem[] = rawItems.map(item => {
    const product = getProductById(item.productId);
    return { productId: item.productId, quantity: item.quantity, unitPriceInCents: product.priceInCents };
  });

  validateItems(items);

  // Decrement stock for each item
  for (const item of items) {
    decrementStock(item.productId, item.quantity);
  }

  return createOrder({
    userId: user.id,
    items,
    status: 'pending',
    placedAt: new Date(),
    total: computeTotal(items),
  });
}

export function cancelOrder(token: string, orderId: string): Order {
  const user = getSessionUser(token);
  const order = getOrderById(orderId);

  if (order.userId !== user.id && user.role !== 'admin') {
    throw new AppError('Cannot cancel another user\'s order', 'AUTH_FORBIDDEN', 403);
  }

  if (order.status === 'shipped' || order.status === 'delivered') {
    throw new AppError('Cannot cancel a shipped or delivered order', 'ORDER_UNMODIFIABLE');
  }

  return updateOrderStatus(orderId, 'cancelled');
}

export function getUserOrders(token: string): Order[] {
  const user = getSessionUser(token);
  return getOrdersByUser(user.id);
}

export function shipOrder(token: string, orderId: string): Order {
  // Only admins can mark orders as shipped
  const user = getSessionUser(token);
  if (user.role !== 'admin') throw new AppError('Admin only', 'AUTH_FORBIDDEN', 403);

  const order = getOrderById(orderId);
  if (order.status !== 'confirmed') {
    throw new AppError('Only confirmed orders can be shipped', 'ORDER_INVALID');
  }
  return updateOrderStatus(orderId, 'shipped');
}
