import { isSensitiveHeaderName } from '@/utils/exportSanitize';

/**
 * 日志详情里的凭据头打码（只影响屏幕上画出来的那串字符）
 *
 * 判据与导出脱敏同源（{@link isSensitiveHeaderName}），避免出现「导出抹了、屏幕上没抹」
 * 这种一半的脱敏。与导出的差别是刻意的：导出是**整条摘掉**（拿到的配置不该带假 token），
 * 这里只是**画成点**，行还在、头名还在、值仍留在本地存储里——排障要看的就是这个头有没有发出去、
 * 发的是哪一把，所以既不删行也不改存储。
 */

/** 打码时保留的尾部字符数（足够分辨「是这把而不是那把」） */
const MASK_TAIL_LENGTH = 4;

/** 短于此长度就整串覆盖：留尾巴等于把整把密钥画出来 */
const MASK_TAIL_MIN_LENGTH = MASK_TAIL_LENGTH * 3;

/** 掩码段的最大长度：再长也只是把面板撑宽，不增加信息 */
const MASK_DOT_LIMIT = 12;

/**
 * 把可能承载凭据的头值画成掩码
 *
 * 长值留尾 4 位（真实 token 的辨识度全在结尾），短值整串覆盖（长度只有几位时尾巴就是全部）。
 * 不回报原长度：`••••••` 与 `••••••••••••••` 的差别本身就在泄露密钥长短。
 */
export function maskHeaderValue(value: string): string {
  const chars = Array.from(String(value ?? ''));
  if (chars.length <= MASK_TAIL_MIN_LENGTH) return '•'.repeat(MASK_DOT_LIMIT);
  const tail = chars.slice(-MASK_TAIL_LENGTH).join('');
  return `${'•'.repeat(MASK_DOT_LIMIT)} ${tail}`;
}

/**
 * 这一格该画掩码还是画原值
 *
 * `revealed` 是界面侧的「本次会话显示原值」开关，默认关；非敏感头一律画原值，
 * 打码只针对会带出会话凭据的那几个头名。
 */
export function resolveHeaderDisplayValue(name: string, value: string, revealed: boolean): string {
  if (revealed || !isSensitiveHeaderName(name)) return String(value ?? '');
  return maskHeaderValue(value);
}
