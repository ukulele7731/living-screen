// Параметры сезона. Пока сезон один — осень; зимой сюда подставится winter.json.
import autumn from '../../seasons/autumn.json';

export type Season = typeof autumn;
export const season: Season = autumn;
