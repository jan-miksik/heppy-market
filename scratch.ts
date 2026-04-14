export function convertToDecimalString(hex: string): string {
  if (hex.startsWith('0x') || hex.startsWith('0X')) {
    return BigInt(hex).toString(10);
  }
  return BigInt(hex || '0').toString(10);
}
console.log(convertToDecimalString('0x10'));
