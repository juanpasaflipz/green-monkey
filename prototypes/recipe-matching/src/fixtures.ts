// Fictional restaurant data. Recipes mirror Luma's shape: linked to dishes only by a free-text name.

export interface MenuItem {
  id: string;
  name: string;
  category: string;
  description: string;
  priceMinor: number; // MXN centavos
}

export interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface LegacyRecipe {
  id: string;
  dishName: string;
  ingredients: Ingredient[];
  // Evaluation only; never sent to TypeSafe. `null` means the correct answer is "no menu item".
  expected: string | null;
  note?: string;
}

export const MENU: MenuItem[] = [
  { id: "m01", name: "Tacos al pastor (orden de 3)", category: "Tacos", description: "Tortilla de maíz, cerdo al pastor, piña, cebolla y cilantro", priceMinor: 7500 },
  { id: "m02", name: "Tacos de suadero (orden de 3)", category: "Tacos", description: "Tortilla de maíz, suadero de res, cebolla y cilantro", priceMinor: 7500 },
  { id: "m03", name: "Tacos de bistec (orden de 3)", category: "Tacos", description: "Tortilla de maíz, bistec de res asado, cebolla y cilantro", priceMinor: 8000 },
  { id: "m04", name: "Gringa de pastor", category: "Tacos", description: "Tortilla de harina, queso Oaxaca gratinado y pastor", priceMinor: 6500 },
  { id: "m05", name: "Quesadilla de flor de calabaza", category: "Antojitos", description: "Tortilla de maíz, flor de calabaza y queso Oaxaca", priceMinor: 5500 },
  { id: "m06", name: "Quesadilla de champiñones", category: "Antojitos", description: "Tortilla de maíz, champiñones salteados y queso Oaxaca", priceMinor: 5500 },
  { id: "m07", name: "Enchiladas verdes de pollo", category: "Platos fuertes", description: "Tres enchiladas de pollo en salsa verde con crema y queso fresco", priceMinor: 13500 },
  { id: "m08", name: "Enchiladas suizas", category: "Platos fuertes", description: "Enchiladas de pollo en salsa verde cremosa, gratinadas con queso manchego", priceMinor: 14500 },
  { id: "m09", name: "Chilaquiles rojos con huevo", category: "Desayunos", description: "Totopos en salsa roja con dos huevos estrellados, crema y cebolla", priceMinor: 11000 },
  { id: "m10", name: "Chilaquiles verdes con pollo", category: "Desayunos", description: "Totopos en salsa verde con pollo deshebrado, crema y queso", priceMinor: 12000 },
  { id: "m11", name: "Pozole rojo (grande)", category: "Platos fuertes", description: "Maíz pozolero y cerdo en caldo de chile guajillo, tazón de 1 L", priceMinor: 16000 },
  { id: "m12", name: "Pozole rojo (chico)", category: "Platos fuertes", description: "Maíz pozolero y cerdo en caldo de chile guajillo, tazón de 500 ml", priceMinor: 11000 },
  { id: "m13", name: "Sopa de tortilla", category: "Entradas", description: "Caldo de jitomate con tiras de tortilla frita, aguacate, queso y chile pasilla", priceMinor: 8500 },
  { id: "m14", name: "Guacamole con totopos", category: "Entradas", description: "Aguacate, jitomate, cebolla, cilantro y chile serrano con totopos", priceMinor: 9500 },
  { id: "m15", name: "Agua de horchata 1 L", category: "Bebidas", description: "Agua fresca de arroz con canela", priceMinor: 4500 },
  { id: "m16", name: "Agua de jamaica 1 L", category: "Bebidas", description: "Agua fresca de flor de jamaica", priceMinor: 4500 },
  { id: "m17", name: "Café de olla", category: "Bebidas", description: "Café con piloncillo y canela", priceMinor: 4000 },
  { id: "m18", name: "Michelada", category: "Bebidas", description: "Cerveza con limón, sal, salsas y chile", priceMinor: 8500 },
  { id: "m19", name: "Refresco de cola 355 ml", category: "Bebidas", description: "Refresco embotellado", priceMinor: 3500 },
  { id: "m20", name: "Flan napolitano", category: "Postres", description: "Flan de huevo y queso crema con caramelo", priceMinor: 6000 },
  { id: "m21", name: "Churros con chocolate", category: "Postres", description: "Cuatro churros con azúcar y canela, taza de chocolate caliente", priceMinor: 7000 },
  { id: "m22", name: "Arroz con leche", category: "Postres", description: "Arroz cocido en leche con canela", priceMinor: 5000 },
];

export const RECIPES: LegacyRecipe[] = [
  {
    id: "r01", dishName: "Taco Pastor", expected: "m01",
    ingredients: [
      { name: "tortilla de maíz", quantity: 3, unit: "pz" },
      { name: "carne al pastor", quantity: 120, unit: "g" },
      { name: "piña", quantity: 20, unit: "g" },
      { name: "cebolla", quantity: 15, unit: "g" },
      { name: "cilantro", quantity: 5, unit: "g" },
    ],
  },
  {
    id: "r02", dishName: "Gringas", expected: "m04",
    ingredients: [
      { name: "tortilla de harina", quantity: 2, unit: "pz" },
      { name: "queso Oaxaca", quantity: 60, unit: "g" },
      { name: "carne al pastor", quantity: 100, unit: "g" },
    ],
  },
  {
    id: "r03", dishName: "Enchiladas Suizas", expected: "m08",
    ingredients: [
      { name: "tortilla de maíz", quantity: 3, unit: "pz" },
      { name: "pollo deshebrado", quantity: 120, unit: "g" },
      { name: "salsa verde", quantity: 150, unit: "ml" },
      { name: "crema", quantity: 60, unit: "ml" },
      { name: "queso manchego", quantity: 50, unit: "g" },
    ],
  },
  {
    id: "r04", dishName: "Enchiladas de pollo en salsa verde", expected: "m07",
    note: "Competes with Enchiladas suizas; no manchego gratin distinguishes it",
    ingredients: [
      { name: "tortilla de maíz", quantity: 3, unit: "pz" },
      { name: "pollo deshebrado", quantity: 120, unit: "g" },
      { name: "salsa verde", quantity: 150, unit: "ml" },
      { name: "crema", quantity: 30, unit: "ml" },
      { name: "queso fresco", quantity: 30, unit: "g" },
      { name: "cebolla", quantity: 10, unit: "g" },
    ],
  },
  {
    id: "r05", dishName: "Chilaquiles", expected: "m09",
    note: "Name omits the color; salsa roja and eggs identify the item",
    ingredients: [
      { name: "totopos", quantity: 120, unit: "g" },
      { name: "salsa roja", quantity: 150, unit: "ml" },
      { name: "huevo", quantity: 2, unit: "pz" },
      { name: "crema", quantity: 30, unit: "ml" },
    ],
  },
  {
    id: "r06", dishName: "Horchata", expected: "m15",
    ingredients: [
      { name: "arroz", quantity: 80, unit: "g" },
      { name: "canela", quantity: 2, unit: "g" },
      { name: "azúcar", quantity: 70, unit: "g" },
      { name: "leche evaporada", quantity: 100, unit: "ml" },
      { name: "agua", quantity: 1, unit: "L" },
    ],
  },
  {
    id: "r07", dishName: "Flor de calabaza", expected: "m05",
    ingredients: [
      { name: "tortilla de maíz", quantity: 1, unit: "pz" },
      { name: "flor de calabaza", quantity: 40, unit: "g" },
      { name: "queso Oaxaca", quantity: 50, unit: "g" },
    ],
  },
  {
    id: "r08", dishName: "Salsa verde (base)", expected: null,
    note: "Prep component used inside other dishes",
    ingredients: [
      { name: "tomate verde", quantity: 1, unit: "kg" },
      { name: "chile serrano", quantity: 60, unit: "g" },
      { name: "ajo", quantity: 15, unit: "g" },
      { name: "cebolla", quantity: 100, unit: "g" },
    ],
  },
  {
    id: "r09", dishName: "Pozole", expected: "m11",
    note: "Size must come from quantities (1 L portion)",
    ingredients: [
      { name: "maíz pozolero", quantity: 250, unit: "g" },
      { name: "carne de cerdo", quantity: 200, unit: "g" },
      { name: "chile guajillo", quantity: 15, unit: "g" },
      { name: "caldo", quantity: 1, unit: "L" },
    ],
  },
  {
    id: "r10", dishName: "Churros w/ chocolate", expected: "m21",
    note: "English/abbreviated name",
    ingredients: [
      { name: "masa para churros", quantity: 160, unit: "g" },
      { name: "chocolate de mesa", quantity: 40, unit: "g" },
      { name: "leche", quantity: 250, unit: "ml" },
      { name: "azúcar con canela", quantity: 15, unit: "g" },
    ],
  },
  {
    id: "r11", dishName: "Mole poblano con pollo", expected: null,
    note: "Not on the menu; chicken dishes are tempting false positives",
    ingredients: [
      { name: "pierna de pollo", quantity: 250, unit: "g" },
      { name: "mole poblano", quantity: 150, unit: "ml" },
      { name: "ajonjolí", quantity: 5, unit: "g" },
      { name: "arroz rojo", quantity: 120, unit: "g" },
    ],
  },
  {
    id: "r12", dishName: "Jamaica", expected: "m16",
    ingredients: [
      { name: "flor de jamaica", quantity: 25, unit: "g" },
      { name: "azúcar", quantity: 70, unit: "g" },
      { name: "agua", quantity: 1, unit: "L" },
    ],
  },
  {
    id: "r13", dishName: "Michelada clásica", expected: "m18",
    ingredients: [
      { name: "cerveza clara", quantity: 355, unit: "ml" },
      { name: "jugo de limón", quantity: 30, unit: "ml" },
      { name: "salsa inglesa", quantity: 5, unit: "ml" },
      { name: "sal", quantity: 3, unit: "g" },
    ],
  },
  {
    id: "r14", dishName: "Flan", expected: "m20",
    ingredients: [
      { name: "huevo", quantity: 1, unit: "pz" },
      { name: "leche condensada", quantity: 60, unit: "ml" },
      { name: "queso crema", quantity: 30, unit: "g" },
      { name: "caramelo", quantity: 20, unit: "g" },
    ],
  },
  {
    id: "r15", dishName: "Café", expected: "m17",
    ingredients: [
      { name: "café molido", quantity: 15, unit: "g" },
      { name: "piloncillo", quantity: 20, unit: "g" },
      { name: "canela", quantity: 2, unit: "g" },
      { name: "agua", quantity: 250, unit: "ml" },
    ],
  },
  {
    id: "r16", dishName: "Quesadilla champiñon", expected: "m06",
    note: "Singular and missing accent/plural",
    ingredients: [
      { name: "tortilla de maíz", quantity: 1, unit: "pz" },
      { name: "champiñón", quantity: 60, unit: "g" },
      { name: "queso Oaxaca", quantity: 50, unit: "g" },
    ],
  },
  {
    id: "r17", dishName: "Sopa Azteca", expected: "m13",
    note: "Regional synonym for sopa de tortilla",
    ingredients: [
      { name: "caldo de jitomate", quantity: 350, unit: "ml" },
      { name: "tortilla frita en tiras", quantity: 40, unit: "g" },
      { name: "aguacate", quantity: 30, unit: "g" },
      { name: "chile pasilla", quantity: 3, unit: "g" },
      { name: "queso fresco", quantity: 25, unit: "g" },
    ],
  },
  {
    id: "r18", dishName: "Guacamole", expected: "m14",
    ingredients: [
      { name: "aguacate", quantity: 200, unit: "g" },
      { name: "jitomate", quantity: 40, unit: "g" },
      { name: "cebolla", quantity: 20, unit: "g" },
      { name: "chile serrano", quantity: 5, unit: "g" },
      { name: "totopos", quantity: 80, unit: "g" },
    ],
  },
  {
    id: "r19", dishName: "Bistec marinado", expected: null,
    note: "Prep component for tacos de bistec, not the sold item",
    ingredients: [
      { name: "bistec de res", quantity: 2, unit: "kg" },
      { name: "jugo de naranja", quantity: 200, unit: "ml" },
      { name: "ajo", quantity: 20, unit: "g" },
      { name: "sal", quantity: 20, unit: "g" },
    ],
  },
  {
    id: "r20", dishName: "Totopos fritos", expected: null,
    note: "Prep component for guacamole and chilaquiles",
    ingredients: [
      { name: "tortilla de maíz", quantity: 1, unit: "kg" },
      { name: "aceite", quantity: 500, unit: "ml" },
      { name: "sal", quantity: 10, unit: "g" },
    ],
  },
];
