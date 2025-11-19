"use server";

import Orders from "./orders"

export default async function OrdersWrapped()
{
    return (<Orders />);
}