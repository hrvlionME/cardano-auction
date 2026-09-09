/** Shapes returned by the account endpoints. Mirrors src/app/api.ts. */

export interface User {
  id: number;
  displayName: string | null;
  email: string | null;
  fullName: string | null;
  addressLine: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  kycStatus: "none" | "pending" | "verified" | "rejected";
  createdAt: string;
}

export interface Me {
  user: User | null;
  address?: string;
  addresses?: string[];
}

export type ProfilePatch = Partial<
  Pick<User, "displayName" | "email" | "fullName" | "addressLine" | "city" | "postcode" | "country">
>;

export interface HistoryRow {
  policyId: string;
  tokenName: string;
  kind: "open" | "bid" | "settle";
  txHash: string;
  blockTime: number;
  amount: number | null;
  bidderAddress: string | null;
  /** Still the standing bid on that auction. */
  standing: boolean;
  phase: "bidding" | "closed" | "settled";
  endTime: number;
}
