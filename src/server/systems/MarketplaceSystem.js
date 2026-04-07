/**
 * MarketplaceSystem — Persistent buy/sell orders with protocol fees.
 */

module.exports = function(WorldState) {
  const proto = WorldState.prototype;

  proto._actionMarketSell = function(agent, action) {
    const { item, quantity, pricePerUnit } = action;
    if (!item || !quantity || quantity <= 0) return { actionId: action.id, success: false, error: 'Missing item or quantity' };
    if (!pricePerUnit || pricePerUnit <= 0) return { actionId: action.id, success: false, error: 'Missing pricePerUnit (in lamports)' };

    const inv = agent.metadata.inventory || {};
    if ((inv[item] || 0) < quantity) return { actionId: action.id, success: false, error: `Not enough ${item}: have ${inv[item] || 0}, need ${quantity}` };

    // Escrow items
    inv[item] -= quantity;
    if (inv[item] <= 0) delete inv[item];
    agent.metadata.inventory = inv;

    const orderId = require('uuid').v4();
    this.marketplace.set(orderId, {
      id: orderId, type: 'sell', agentId: agent.id, agentName: agent.name,
      item, quantity, pricePerUnit, createdAt: this.tick, expiresAt: this.tick + 1000,
    });

    this.tickEvents.push({ type: 'market_order_created', orderId, agentName: agent.name, item, quantity, pricePerUnit, tick: this.tick });
    return { actionId: action.id, success: true, data: { orderId, item, quantity, pricePerUnit } };
  };

  proto._actionMarketBuy = function(agent, action) {
    const { orderId, quantity } = action;
    const order = this.marketplace.get(orderId);
    if (!order) return { actionId: action.id, success: false, error: 'Order not found' };
    if (order.type !== 'sell') return { actionId: action.id, success: false, error: 'Can only buy from sell orders' };
    if (this.tick > order.expiresAt) return { actionId: action.id, success: false, error: 'Order expired' };
    if (order.agentId === agent.id) return { actionId: action.id, success: false, error: 'Cannot buy your own order' };

    const buyQty = Math.min(quantity || order.quantity, order.quantity);
    const totalCost = buyQty * order.pricePerUnit;

    const payment = this.spend(agent.id, totalCost, `market buy: ${buyQty}x ${order.item}`);
    if (!payment.success) return { actionId: action.id, success: false, error: `Cannot afford: ${payment.error}` };

    // Pay seller (minus 1% fee, waived during trader's boon)
    const fee = (this._activeWorldEvent?.type === 'trader_boon') ? 0 : Math.floor(totalCost * 0.01);
    this.earn(order.agentId, totalCost - fee, `market sale: ${buyQty}x ${order.item}`);
    if (fee > 0) this.protocolRevenue += fee;

    // Give items to buyer
    const inv = agent.metadata.inventory || {};
    inv[order.item] = (inv[order.item] || 0) + buyQty;
    agent.metadata.inventory = inv;

    // Update or remove order
    order.quantity -= buyQty;
    if (order.quantity <= 0) this.marketplace.delete(orderId);

    this.tickEvents.push({ type: 'market_trade', orderId, buyer: agent.name, seller: order.agentName, item: order.item, quantity: buyQty, totalCost, tick: this.tick });
    return { actionId: action.id, success: true, data: { bought: buyQty, item: order.item, totalCost, inventory: inv } };
  };

  proto._actionMarketList = function(agent, action) {
    const filter = action.item;
    const orders = [];
    for (const [, order] of this.marketplace) {
      if (this.tick > order.expiresAt) continue;
      if (filter && order.item !== filter) continue;
      orders.push({ id: order.id, type: order.type, item: order.item, quantity: order.quantity, pricePerUnit: order.pricePerUnit, seller: order.agentName, expiresIn: order.expiresAt - this.tick });
    }
    orders.sort((a, b) => a.pricePerUnit - b.pricePerUnit);
    return { actionId: action.id, success: true, data: { orders, count: orders.length } };
  };

  proto._actionMarketCancel = function(agent, action) {
    const order = this.marketplace.get(action.orderId);
    if (!order) return { actionId: action.id, success: false, error: 'Order not found' };
    if (order.agentId !== agent.id) return { actionId: action.id, success: false, error: 'Not your order' };

    // Return escrowed items
    const inv = agent.metadata.inventory || {};
    inv[order.item] = (inv[order.item] || 0) + order.quantity;
    agent.metadata.inventory = inv;

    this.marketplace.delete(action.orderId);
    this.tickEvents.push({ type: 'market_order_cancelled', orderId: action.orderId, tick: this.tick });
    return { actionId: action.id, success: true, data: { returned: order.item, quantity: order.quantity } };
  };
};
