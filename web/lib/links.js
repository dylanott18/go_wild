const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Frontier booking-results URL for one origin/destination/date (YYYY-MM-DD). */
export function frontierUrl(origin, dest, date) {
  const [y, m, d] = date.split('-').map(Number);
  const dd1 = encodeURIComponent(`${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`);
  return `https://booking.flyfrontier.com/Flight/InternalSelect?o1=${origin}&d1=${dest}&dd1=${dd1}&ADT=1&mon=true&promo=`;
}
