// 預設分類（建立家庭時自動套用）
export const DEFAULT_CATEGORIES = [
  // 支出
  { name: '餐飲', icon: '🍱', type: 'EXPENSE', sortOrder: 1 },
  { name: '交通', icon: '🚗', type: 'EXPENSE', sortOrder: 2 },
  { name: '購物', icon: '🛒', type: 'EXPENSE', sortOrder: 3 },
  { name: '生活', icon: '🏠', type: 'EXPENSE', sortOrder: 4 },
  { name: '娛樂', icon: '🎮', type: 'EXPENSE', sortOrder: 5 },
  { name: '醫療', icon: '💊', type: 'EXPENSE', sortOrder: 6 },
  { name: '教育', icon: '📚', type: 'EXPENSE', sortOrder: 7 },
  { name: '寵物', icon: '🐾', type: 'EXPENSE', sortOrder: 8 },
  { name: '其他支出', icon: '📌', type: 'EXPENSE', sortOrder: 99 },
  // 收入
  { name: '薪資', icon: '💰', type: 'INCOME', sortOrder: 1 },
  { name: '獎金', icon: '🎁', type: 'INCOME', sortOrder: 2 },
  { name: '投資', icon: '📈', type: 'INCOME', sortOrder: 3 },
  { name: '其他收入', icon: '📌', type: 'INCOME', sortOrder: 99 },
] as const;
