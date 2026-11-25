package main

// 応答の形（backend/app/schemas.py の移植）。項目の順は pydantic のモデルと同じ（FastAPI の response_model が、この順で出す）。
// null になりうる項目はポインター。配列は、空でも [] で出す（nil にしない）。

type storeOut struct {
	ID               int     `json:"id"`
	Code             string  `json:"code"`
	Name             string  `json:"name"`
	Area             string  `json:"area"`
	Address          string  `json:"address"`
	OpenTime         string  `json:"open_time"`
	CloseTime        string  `json:"close_time"`
	ClosedWeekday    *int    `json:"closed_weekday"`
	LastOrderMinutes int     `json:"last_order_minutes"`
	MobileOrder      bool    `json:"mobile_order"`
	Seats            int     `json:"seats"`
	AcceptingOrders  bool    `json:"accepting_orders"`
	ClosedReason     *string `json:"closed_reason"`
}

type variantOut struct {
	ID                int     `json:"id"`
	Size              string  `json:"size"`
	Temperature       string  `json:"temperature"`
	PriceLumi         int     `json:"price_lumi"`
	Available         bool    `json:"available"`
	UnavailableReason *string `json:"unavailable_reason"`
}

type menuItemOut struct {
	ID          int          `json:"id"`
	Code        string       `json:"code"`
	Name        string       `json:"name"`
	Category    string       `json:"category"`
	Description string       `json:"description"`
	Allergens   []string     `json:"allergens"`
	SeasonFrom  *string      `json:"season_from"`
	SeasonTo    *string      `json:"season_to"`
	SoldFrom    *string      `json:"sold_from"`
	SoldUntil   *string      `json:"sold_until"`
	Variants    []variantOut `json:"variants"`
}

type storeRef struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type cartLineOut struct {
	VariantID         int     `json:"variant_id"`
	ItemCode          string  `json:"item_code"`
	Name              string  `json:"name"`
	Size              string  `json:"size"`
	Temperature       string  `json:"temperature"`
	UnitPriceLumi     int     `json:"unit_price_lumi"`
	Qty               int     `json:"qty"`
	LineTotalLumi     int     `json:"line_total_lumi"`
	Available         bool    `json:"available"`
	UnavailableReason *string `json:"unavailable_reason"`
}

type cartOut struct {
	Version         int           `json:"version"`
	Store           *storeRef     `json:"store"`
	Fulfillment     string        `json:"fulfillment"`
	Lines           []cartLineOut `json:"lines"`
	SubtotalLumi    int           `json:"subtotal_lumi"`
	DeliveryFeeLumi int           `json:"delivery_fee_lumi"`
	TotalLumi       int           `json:"total_lumi"`
	Delivery        *cartDelivery `json:"delivery"`
}

type proposalOut struct {
	ID              string        `json:"id"`
	CartVersion     int           `json:"cart_version"`
	TotalLumi       int           `json:"total_lumi"`
	ExpiresAt       string        `json:"expires_at"`
	Store           storeRef      `json:"store"`
	Lines           []cartLineOut `json:"lines"`
	PickupNote      *string       `json:"pickup_note"`
	Fulfillment     string        `json:"fulfillment"`
	SubtotalLumi    int           `json:"subtotal_lumi"`
	DeliveryFeeLumi int           `json:"delivery_fee_lumi"`
	Delivery        *cartDelivery `json:"delivery"`
}

type orderItemOut struct {
	Name          string `json:"name"`
	Size          string `json:"size"`
	Temperature   string `json:"temperature"`
	UnitPriceLumi int    `json:"unit_price_lumi"`
	Qty           int    `json:"qty"`
	LineTotalLumi int    `json:"line_total_lumi"`
}

type orderEventOut struct {
	ToStatus  string  `json:"to_status"`
	At        string  `json:"at"`
	ActorType string  `json:"actor_type"`
	Reason    *string `json:"reason"`
}

type paymentInfo struct {
	Provider string `json:"provider"`
	Status   string `json:"status"`
}

type orderOut struct {
	PublicID             string          `json:"public_id"`
	PickupNo             int             `json:"pickup_no"`
	Status               string          `json:"status"`
	Fulfillment          string          `json:"fulfillment"`
	Store                storeRef        `json:"store"`
	Items                []orderItemOut  `json:"items"`
	SubtotalLumi         int             `json:"subtotal_lumi"`
	DeliveryFeeLumi      int             `json:"delivery_fee_lumi"`
	TotalLumi            int             `json:"total_lumi"`
	PlacedAt             string          `json:"placed_at"`
	ReservationExpiresAt *string         `json:"reservation_expires_at"`
	Payment              *paymentInfo    `json:"payment"`
	Events               []orderEventOut `json:"events"`
	CancelReason         *string         `json:"cancel_reason"`
	CanPay               bool            `json:"can_pay"`
	CanCancel            bool            `json:"can_cancel"`
	Delivery             *orderDelivery  `json:"delivery"`
}

type orderSummaryOut struct {
	PublicID    string   `json:"public_id"`
	PickupNo    int      `json:"pickup_no"`
	Status      string   `json:"status"`
	Fulfillment string   `json:"fulfillment"`
	Store       storeRef `json:"store"`
	TotalLumi   int      `json:"total_lumi"`
	PlacedAt    string   `json:"placed_at"`
}

type staffOrderOut struct {
	PublicID             string              `json:"public_id"`
	PickupNo             int                 `json:"pickup_no"`
	Status               string              `json:"status"`
	Fulfillment          string              `json:"fulfillment"`
	Store                storeRef            `json:"store"`
	Items                []orderItemOut      `json:"items"`
	SubtotalLumi         int                 `json:"subtotal_lumi"`
	DeliveryFeeLumi      int                 `json:"delivery_fee_lumi"`
	TotalLumi            int                 `json:"total_lumi"`
	PlacedAt             string              `json:"placed_at"`
	ReservationExpiresAt *string             `json:"reservation_expires_at"`
	Events               []orderEventOut     `json:"events"`
	CancelReason         *string             `json:"cancel_reason"`
	CanPay               bool                `json:"can_pay"`
	CanCancel            bool                `json:"can_cancel"`
	AllowedActions       []string            `json:"allowed_actions"`
	Delivery             *staffOrderDelivery `json:"delivery"`
}

// dispatchOrderOut は DispatchOrder（StaffOrder に suggestion を足したもの）。
type dispatchOrderOut struct {
	staffOrderOut
	Suggestion *suggestionOut `json:"suggestion"`
}

type staffOut struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Role    string `json:"role"`
	StoreID *int   `json:"store_id"`
}

type loginOut struct {
	Token     string   `json:"token"`
	ExpiresAt string   `json:"expires_at"`
	Staff     staffOut `json:"staff"`
}

type stockRowOut struct {
	ItemID       int    `json:"item_id"`
	Code         string `json:"code"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Unit         string `json:"unit"`
	OnHand       int    `json:"on_hand"`
	Reserved     int    `json:"reserved"`
	Available    int    `json:"available"`
	ReorderPoint int    `json:"reorder_point"`
	Low          bool   `json:"low"`
}

// ---- 宅配（P2）----

type slotRef struct {
	ID       int    `json:"id"`
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
}

type zoneRef struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type zoneOut struct {
	ID           int    `json:"id"`
	Name         string `json:"name"`
	AreaCode     int    `json:"area_code"`
	FeeLumi      int    `json:"fee_lumi"`
	FreeOverLumi *int   `json:"free_over_lumi"`
	MinOrderLumi int    `json:"min_order_lumi"`
	BaseMinutes  int    `json:"base_minutes"`
	IsSuspended  bool   `json:"is_suspended"`
}

type addressBrief struct {
	ID       int    `json:"id"`
	Label    string `json:"label"`
	AreaCode int    `json:"area_code"`
	AreaName string `json:"area_name"`
}

type addressOut struct {
	ID        int     `json:"id"`
	Label     string  `json:"label"`
	AreaCode  int     `json:"area_code"`
	AreaName  string  `json:"area_name"`
	ZoneID    *int    `json:"zone_id"`
	Line      string  `json:"line"`
	Note      *string `json:"note"`
	CreatedAt string  `json:"created_at"`
}

type cartDelivery struct {
	Address      *addressBrief `json:"address"`
	Zone         *zoneOut      `json:"zone"`
	Slot         *slotRef      `json:"slot"`
	FeeLumi      int           `json:"fee_lumi"`
	FreeOverLumi *int          `json:"free_over_lumi"`
	MinOrderLumi *int          `json:"min_order_lumi"`
	Issues       []string      `json:"issues"`
}

type courierName struct {
	Name string `json:"name"`
}

type courierRef struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type addressLabel struct {
	Label string `json:"label"`
}

type orderDelivery struct {
	Status        string       `json:"status"`
	Zone          zoneRef      `json:"zone"`
	Slot          slotRef      `json:"slot"`
	Courier       *courierName `json:"courier"`
	Pin           *string      `json:"pin"`
	EtaAt         *string      `json:"eta_at"`
	Address       addressLabel `json:"address"`
	Attempt       int          `json:"attempt"`
	FailureReason *string      `json:"failure_reason"`
}

type staffOrderDelivery struct {
	Status        string      `json:"status"`
	Zone          zoneRef     `json:"zone"`
	Slot          slotRef     `json:"slot"`
	Courier       *courierRef `json:"courier"`
	Attempt       int         `json:"attempt"`
	FailureReason *string     `json:"failure_reason"`
}

type slotOut struct {
	ID                int     `json:"id"`
	StartsAt          string  `json:"starts_at"`
	EndsAt            string  `json:"ends_at"`
	Capacity          int     `json:"capacity"`
	Booked            int     `json:"booked"`
	Remaining         int     `json:"remaining"`
	Available         bool    `json:"available"`
	UnavailableReason *string `json:"unavailable_reason"`
}

type slotListOut struct {
	StoreID int       `json:"store_id"`
	Date    string    `json:"date"`
	ZoneID  *int      `json:"zone_id"`
	Reason  *string   `json:"reason"`
	Slots   []slotOut `json:"slots"`
}

type courierOut struct {
	ID          int      `json:"id"`
	StoreID     int      `json:"store_id"`
	Name        string   `json:"name"`
	Vehicle     string   `json:"vehicle"`
	IsOnDuty    bool     `json:"is_on_duty"`
	ActiveCount int      `json:"active_count"`
	Zone        *zoneRef `json:"zone"`
}

type suggestionOut struct {
	CourierID   int    `json:"courier_id"`
	CourierName string `json:"courier_name"`
	Minutes     int    `json:"minutes"`
}

type dispatchBoardOut struct {
	Provider string             `json:"provider"`
	Couriers []courierOut       `json:"couriers"`
	Orders   []dispatchOrderOut `json:"orders"`
}

type courierItemOut struct {
	Name        string `json:"name"`
	Size        string `json:"size"`
	Temperature string `json:"temperature"`
	Qty         int    `json:"qty"`
}

type courierAddressOut struct {
	Label string  `json:"label"`
	Line  string  `json:"line"`
	Note  *string `json:"note"`
}

type courierDeliveryOut struct {
	PublicID        string             `json:"public_id"`
	PickupNo        int                `json:"pickup_no"`
	Status          string             `json:"status"`
	Store           storeRef           `json:"store"`
	Zone            zoneRef            `json:"zone"`
	Slot            slotRef            `json:"slot"`
	Items           []courierItemOut   `json:"items"`
	Address         *courierAddressOut `json:"address"`
	Attempt         int                `json:"attempt"`
	PinAttemptsLeft *int               `json:"pin_attempts_left"`
	EtaAt           *string            `json:"eta_at"`
	AllowedActions  []string           `json:"allowed_actions"`
}

// strPtr は空でない文字列のポインター（nil なら nil）。
func strPtrOf(s *string) *string { return s }

// emptyIfNil は nil の配列を空の配列にする（JSON で null にしない）。
func emptyIfNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
