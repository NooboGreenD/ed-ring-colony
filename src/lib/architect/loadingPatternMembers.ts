/** Wire types only; never put grants in the public/copyable definition. */
export type LoadingCollaboration = {
  canManage: boolean;
  self: { accepted: boolean; sharedCarrierIds: string[] };
  ownCarrierIds: string[];
  participants: {
    userId: string;
    name: string;
    accepted: boolean;
    sharedCarrierIds: string[];
  }[];
};
