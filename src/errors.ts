export class ApiError extends Error {
  constructor(public status:number,public code:string,message:string) {super(message);}
}
export function deny(status:number,code:string,message:string):never {throw new ApiError(status,code,message);}
