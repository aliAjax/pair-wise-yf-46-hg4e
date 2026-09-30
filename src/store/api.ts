import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { RundownItem } from "../types";

const KEY = "pair-wise-yf-46/rundown";

export const rundownApi = createApi({
  reducerPath: "rundownApi",
  baseQuery: fakeBaseQuery(),
  tagTypes: ["Rundown"],
  endpoints: (builder) => ({
    getRundown: builder.query<RundownItem[], void>({
      queryFn: async () => {
        const raw = localStorage.getItem(KEY);
        return { data: raw ? JSON.parse(raw) as RundownItem[] : [] };
      },
      providesTags: ["Rundown"]
    }),
    saveRundown: builder.mutation<{ ok: true }, RundownItem[]>({
      queryFn: async (items) => {
        localStorage.setItem(KEY, JSON.stringify(items));
        return { data: { ok: true } };
      },
      invalidatesTags: ["Rundown"]
    })
  })
});

export const { useGetRundownQuery, useSaveRundownMutation } = rundownApi;
