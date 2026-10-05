// Fictional suppliers, ingredient catalog, and receipt lines whose text has already been extracted.

export type StockUnit = "kg" | "L" | "pz";

export interface Ingredient {
  id: string;
  name: string;
  stockUnit: StockUnit;
}

export interface Supplier {
  id: string;
  name: string;
  kind: string;
}

export interface ReceiptLine {
  id: string;
  supplierId: string;
  text: string;
  quantity: number;
  unit: string; // As printed on the receipt: KG, PZA, CJA, PQ, SERV, ...
  // Evaluation only; never sent to TypeSafe.
  expected: string; // Ingredient ID, "new_ingredient", or "not_inventory".
  expectedStockQuantity?: number | null; // In the ingredient's stock unit; `null` means conversion needs review.
  note?: string;
}

export const SUPPLIERS: Supplier[] = [
  { id: "s1", name: "Frutas y Verduras La Merced", kind: "Frutas y verduras" },
  { id: "s2", name: "Avícola San Juan", kind: "Pollo y huevo" },
  { id: "s3", name: "Carnes Don Beto", kind: "Carnicería de res y cerdo" },
  { id: "s4", name: "Abarrotes El Güero", kind: "Abarrotes" },
  { id: "s5", name: "Depósito La Frontera", kind: "Cerveza y refrescos" },
  { id: "s6", name: "Cremería La Vaquita", kind: "Lácteos y quesos" },
];

export const INGREDIENTS: Ingredient[] = [
  { id: "i01", name: "Jitomate saladet", stockUnit: "kg" },
  { id: "i02", name: "Tomate verde", stockUnit: "kg" },
  { id: "i03", name: "Cebolla blanca", stockUnit: "kg" },
  { id: "i04", name: "Cilantro", stockUnit: "kg" },
  { id: "i05", name: "Aguacate Hass", stockUnit: "kg" },
  { id: "i06", name: "Chile serrano", stockUnit: "kg" },
  { id: "i07", name: "Chile jalapeño en escabeche (lata)", stockUnit: "kg" },
  { id: "i08", name: "Chile guajillo seco", stockUnit: "kg" },
  { id: "i09", name: "Limón sin semilla", stockUnit: "kg" },
  { id: "i10", name: "Piña", stockUnit: "kg" },
  { id: "i11", name: "Queso Oaxaca", stockUnit: "kg" },
  { id: "i12", name: "Queso fresco", stockUnit: "kg" },
  { id: "i13", name: "Queso manchego", stockUnit: "kg" },
  { id: "i14", name: "Crema ácida", stockUnit: "L" },
  { id: "i15", name: "Leche evaporada (lata 360 g)", stockUnit: "pz" },
  { id: "i16", name: "Huevo blanco", stockUnit: "pz" },
  { id: "i17", name: "Tortilla de maíz", stockUnit: "kg" },
  { id: "i18", name: "Tortilla de harina 30 cm", stockUnit: "pz" },
  { id: "i19", name: "Pechuga de pollo sin hueso", stockUnit: "kg" },
  { id: "i20", name: "Pierna y muslo de pollo", stockUnit: "kg" },
  { id: "i21", name: "Pierna de cerdo", stockUnit: "kg" },
  { id: "i22", name: "Bistec de res", stockUnit: "kg" },
  { id: "i23", name: "Suadero de res", stockUnit: "kg" },
  { id: "i24", name: "Aceite vegetal", stockUnit: "L" },
  { id: "i25", name: "Arroz", stockUnit: "kg" },
  { id: "i26", name: "Azúcar estándar", stockUnit: "kg" },
  { id: "i27", name: "Canela en rama", stockUnit: "kg" },
  { id: "i28", name: "Café molido", stockUnit: "kg" },
  { id: "i29", name: "Piloncillo", stockUnit: "kg" },
  { id: "i30", name: "Cerveza clara 355 ml", stockUnit: "pz" },
  { id: "i31", name: "Flor de jamaica", stockUnit: "kg" },
  { id: "i32", name: "Maíz pozolero", stockUnit: "kg" },
];

export const LINES: ReceiptLine[] = [
  { id: "L01", supplierId: "s1", text: "JITOMATE SALADET 1RA", quantity: 25, unit: "KG", expected: "i01", expectedStockQuantity: 25 },
  { id: "L02", supplierId: "s1", text: "TOMATE VERDE C/CASCARA", quantity: 10, unit: "KG", expected: "i02", expectedStockQuantity: 10 },
  { id: "L03", supplierId: "s1", text: "AGUACATE HASS 2DA", quantity: 30, unit: "PZA", expected: "i05", expectedStockQuantity: null, note: "Bought by the piece but stocked by kg; no weight on the line" },
  { id: "L04", supplierId: "s1", text: "CHILE JALAPEÑO", quantity: 3, unit: "KG", expected: "new_ingredient", note: "Fresh, while the catalog only has canned jalapeños" },
  { id: "L05", supplierId: "s1", text: "LIMON S/SEM", quantity: 5, unit: "KG", expected: "i09", expectedStockQuantity: 5 },
  { id: "L06", supplierId: "s2", text: "PECH POLLO S/H", quantity: 8, unit: "KG", expected: "i19", expectedStockQuantity: 8 },
  { id: "L07", supplierId: "s2", text: "PIERNA", quantity: 6, unit: "KG", expected: "i20", expectedStockQuantity: 6, note: "Same text as L08; the poultry supplier means chicken" },
  { id: "L08", supplierId: "s3", text: "PIERNA", quantity: 10, unit: "KG", expected: "i21", expectedStockQuantity: 10, note: "Same text as L07; the butcher means pork" },
  { id: "L09", supplierId: "s3", text: "SUADERO", quantity: 7, unit: "KG", expected: "i23", expectedStockQuantity: 7 },
  { id: "L10", supplierId: "s4", text: "ACEITE 1-2-3 20L", quantity: 1, unit: "PZA", expected: "i24", expectedStockQuantity: 20, note: "Brand name" },
  { id: "L11", supplierId: "s4", text: "ARROZ SUPER EXTRA 1KG C/10", quantity: 2, unit: "CJA", expected: "i25", expectedStockQuantity: 20 },
  { id: "L12", supplierId: "s4", text: "AZUCAR MORENA 1KG", quantity: 5, unit: "PZA", expected: "new_ingredient", note: "Brown sugar is not the stocked standard sugar" },
  { id: "L13", supplierId: "s4", text: "LECHE EVAP 360G C/48", quantity: 1, unit: "CJA", expected: "i15", expectedStockQuantity: 48 },
  { id: "L14", supplierId: "s4", text: "MASECA 20KG", quantity: 1, unit: "PZA", expected: "new_ingredient", note: "Corn flour brand; tortillas are a different product" },
  { id: "L15", supplierId: "s4", text: "CLORO 1L C/12", quantity: 1, unit: "CJA", expected: "not_inventory", note: "Cleaning supply" },
  { id: "L16", supplierId: "s4", text: "FLETE", quantity: 1, unit: "SERV", expected: "not_inventory", note: "Delivery fee" },
  { id: "L17", supplierId: "s5", text: "CORONA EXTRA 355ML C/24", quantity: 3, unit: "CJA", expected: "i30", expectedStockQuantity: 72, note: "Brand name" },
  { id: "L18", supplierId: "s5", text: "ENVASE RETORNABLE", quantity: 3, unit: "CJA", expected: "not_inventory", note: "Bottle deposit" },
  { id: "L19", supplierId: "s6", text: "QSO OAX 1KG", quantity: 4, unit: "PZA", expected: "i11", expectedStockQuantity: 4 },
  { id: "L20", supplierId: "s6", text: "QSO FCO", quantity: 2, unit: "KG", expected: "i12", expectedStockQuantity: 2 },
  { id: "L21", supplierId: "s6", text: "CREMA 4L", quantity: 2, unit: "PZA", expected: "i14", expectedStockQuantity: 8 },
  { id: "L22", supplierId: "s6", text: "DESC PRONTO PAGO", quantity: 1, unit: "", expected: "not_inventory", note: "Early-payment discount" },
  { id: "L23", supplierId: "s4", text: "TORT HNA 30CM PQ/20", quantity: 3, unit: "PQ", expected: "i18", expectedStockQuantity: 60 },
  { id: "L24", supplierId: "s4", text: "JAMAICA", quantity: 1, unit: "KG", expected: "i31", expectedStockQuantity: 1 },
];
